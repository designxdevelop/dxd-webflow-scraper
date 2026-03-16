import path from "node:path";
import os from "node:os";
import nodeFs from "node:fs/promises";
import fs from "fs-extra";
import { chromium, Browser, BrowserContext } from "playwright";
import { fetchSitemapUrls } from "./sitemap-parser.js";
import { AssetDownloader } from "./asset-downloader.js";
import { AssetCache } from "./asset-cache.js";
import { processPage } from "./page-processor.js";
import { CrawlOptions, CrawlResult, CrawlState, CrawlProgress } from "./types.js";
import { log, runWithLogCallback } from "./logger.js";
import { captureMemorySnapshot, formatMemoryBytes, formatMemorySnapshot } from "./memory.js";
import { writeOutputConfig } from "./output-config.js";
import {
  getStateFilePath,
  loadState,
  updateStateProgress,
  filterUrlsForResume,
} from "./state-manager.js";
import { extractLinks } from "./link-extractor.js";

const CRAWL_ABORT_MESSAGE = "Crawl cancelled by request.";
// Configurable batch size for state persistence - smaller = more frequent writes but safer against crashes
const STATE_FLUSH_BATCH_SIZE = readPositiveInt("CRAWL_STATE_FLUSH_BATCH_SIZE", 25);
const DEFAULT_MEMORY_LOG_EVERY_PAGES = 25;

function readPositiveInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Clean up timer if promise resolves first
      timer.unref?.();
    }),
  ]);
}

async function shouldAbort(options: CrawlOptions): Promise<boolean> {
  if (options.signal?.aborted) {
    return true;
  }
  if (!options.shouldAbort) {
    return false;
  }
  return await options.shouldAbort();
}

async function assertNotAborted(options: CrawlOptions): Promise<void> {
  if (await shouldAbort(options)) {
    throw new Error(CRAWL_ABORT_MESSAGE);
  }
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes(CRAWL_ABORT_MESSAGE);
}

function isPlaywrightClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes("target page, context or browser has been closed") ||
    msg.includes("browser has been closed") ||
    msg.includes("context has been closed") ||
    msg.includes("target closed") ||
    msg.includes("browser disconnected")
  );
}

export interface ContainerMemoryInfo {
  limitBytes: number | null;
  source: "cgroup-v2" | "cgroup-v1" | "host";
}

export interface CrawlRuntimePlan {
  effectiveConcurrency: number;
  numBrowsers: number;
  concurrencyPerBrowser: number;
  availableMemoryBytes: number;
  memorySource: "container" | "host";
  containerLimitBytes: number | null;
  processRssBytes: number;
  rssSafetyCapApplied: boolean;
}

export interface CrawlRuntimePlanInput {
  requestedConcurrency: number;
  configuredMaxConcurrency: number;
  cpuCount: number;
  hostFreeMemoryBytes: number;
  processRssBytes: number;
  containerLimitBytes: number | null;
  memoryBufferBytes: number;
  memoryBytesPerPage: number;
  memoryBytesPerBrowser: number;
  pagesPerBrowser: number;
  disableResourceChecks: boolean;
  overrideConcurrency: number;
  overrideBrowsers: number;
  rssSafetyThresholdPercent: number;
}

export function calculateCrawlRuntimePlan(input: CrawlRuntimePlanInput): CrawlRuntimePlan {
  const {
    requestedConcurrency,
    configuredMaxConcurrency,
    cpuCount,
    hostFreeMemoryBytes,
    processRssBytes,
    containerLimitBytes,
    memoryBufferBytes,
    memoryBytesPerPage,
    memoryBytesPerBrowser,
    pagesPerBrowser,
    disableResourceChecks,
    overrideConcurrency,
    overrideBrowsers,
    rssSafetyThresholdPercent,
  } = input;

  if (overrideConcurrency > 0 && overrideBrowsers > 0) {
    return {
      effectiveConcurrency: overrideConcurrency,
      numBrowsers: overrideBrowsers,
      concurrencyPerBrowser: Math.max(1, Math.ceil(overrideConcurrency / overrideBrowsers)),
      availableMemoryBytes: hostFreeMemoryBytes,
      memorySource: containerLimitBytes ? "container" : "host",
      containerLimitBytes,
      processRssBytes,
      rssSafetyCapApplied: false,
    };
  }

  const hostAvailableBytes = Math.max(memoryBytesPerPage, hostFreeMemoryBytes - memoryBufferBytes);
  const containerAvailableBytes =
    containerLimitBytes && Number.isFinite(containerLimitBytes)
      ? Math.max(memoryBytesPerPage, containerLimitBytes - processRssBytes - memoryBufferBytes)
      : null;
  const availableMemoryBytes = containerAvailableBytes === null
    ? hostAvailableBytes
    : Math.min(hostAvailableBytes, containerAvailableBytes);
  const memorySource = containerAvailableBytes === null ? "host" : "container";

  const maxConcurrencyByMemory = Math.max(1, Math.floor(availableMemoryBytes / Math.max(1, memoryBytesPerPage)));
  let effectiveConcurrency = disableResourceChecks
    ? Math.min(requestedConcurrency, configuredMaxConcurrency)
    : Math.max(
        1,
        Math.min(requestedConcurrency, configuredMaxConcurrency, cpuCount * 2, maxConcurrencyByMemory)
      );

  let rssSafetyCapApplied = false;
  if (!disableResourceChecks && containerLimitBytes && Number.isFinite(containerLimitBytes)) {
    const rssSafetyCeilingBytes = Math.max(
      memoryBytesPerPage,
      Math.floor(containerLimitBytes * clampPercent(rssSafetyThresholdPercent))
    );
    const remainingSafetyBytes = Math.max(memoryBytesPerPage, rssSafetyCeilingBytes - processRssBytes);
    const maxConcurrencyBySafety = Math.max(1, Math.floor(remainingSafetyBytes / Math.max(1, memoryBytesPerPage)));
    const nextConcurrency = Math.min(effectiveConcurrency, maxConcurrencyBySafety);
    rssSafetyCapApplied = nextConcurrency < effectiveConcurrency;
    effectiveConcurrency = nextConcurrency;
  }

  const maxBrowsersByMemory = Math.max(1, Math.floor(availableMemoryBytes / Math.max(1, memoryBytesPerBrowser)));
  const maxBrowsersByCPU = Math.max(1, Math.floor(cpuCount));
  const desiredBrowsers = effectiveConcurrency >= 4 ? Math.max(2, Math.ceil(effectiveConcurrency / pagesPerBrowser)) : 1;

  const numBrowsers = overrideBrowsers > 0
    ? overrideBrowsers
    : disableResourceChecks
      ? desiredBrowsers
      : Math.max(1, Math.min(desiredBrowsers, maxBrowsersByCPU, maxBrowsersByMemory));

  return {
    effectiveConcurrency,
    numBrowsers,
    concurrencyPerBrowser: Math.max(1, Math.ceil(effectiveConcurrency / numBrowsers)),
    availableMemoryBytes,
    memorySource,
    containerLimitBytes,
    processRssBytes,
    rssSafetyCapApplied,
  };
}

export async function readContainerMemoryInfo(
  fileReader: (filePath: string) => Promise<string> = async (filePath) => nodeFs.readFile(filePath, "utf8")
): Promise<ContainerMemoryInfo> {
  const candidates: Array<{ path: string; source: ContainerMemoryInfo["source"] }> = [
    { path: "/sys/fs/cgroup/memory.max", source: "cgroup-v2" },
    { path: "/sys/fs/cgroup/memory/memory.limit_in_bytes", source: "cgroup-v1" },
  ];

  for (const candidate of candidates) {
    try {
      const value = parseContainerMemoryLimit(await fileReader(candidate.path));
      if (value !== null) {
        return { limitBytes: value, source: candidate.source };
      }
    } catch {
      // Ignore unreadable cgroup files.
    }
  }

  return { limitBytes: null, source: "host" };
}

export function parseContainerMemoryLimit(raw: string): number | null {
  const normalized = raw.trim();
  if (!normalized || normalized === "max") {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  if (parsed >= Number.MAX_SAFE_INTEGER) {
    return null;
  }

  return parsed;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0.85;
  }
  if (value >= 1) {
    return 0.99;
  }
  return value;
}

export function resolveCrawlSource(
  baseUrl: string,
  sitemapUrls: string[],
  options: Pick<CrawlOptions, "sitemapOnly" | "discoverLinks">
): {
  seedUrls: string[];
  usedSitemap: boolean;
  usedFallback: boolean;
  sitemapOnly: boolean;
  discoverLinks: boolean;
} {
  if (sitemapUrls.length > 0) {
    const sitemapOnly = options.sitemapOnly !== false;
    const discoverLinks = sitemapOnly ? false : (options.discoverLinks ?? false);
    return {
      seedUrls: sitemapUrls,
      usedSitemap: true,
      usedFallback: false,
      sitemapOnly,
      discoverLinks,
    };
  }

  const normalizedBaseUrl = normalizeSeedUrl(baseUrl);
  return {
    seedUrls: [normalizedBaseUrl],
    usedSitemap: false,
    usedFallback: true,
    sitemapOnly: false,
    discoverLinks: true,
  };
}

function normalizeSeedUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  if (!parsed.pathname) {
    parsed.pathname = "/";
  }
  return parsed.toString();
}

/**
 * Determine if an error is transient and worth retrying.
 */
function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  // Retry on timeouts, 5xx, network errors
  return (
    msg.includes("timeout") ||
    msg.includes("net::err") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("500") ||
    msg.includes("429") ||
    isPlaywrightClosedError(error)
  );
}

/**
 * Retry a function with exponential backoff.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
  label: string,
  shouldAbortFn?: () => boolean | Promise<boolean>,
  onRetry?: (error: unknown, nextAttempt: number) => void | Promise<void>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry abort errors
      if (isAbortError(error)) throw error;

      // Don't retry non-transient errors
      if (!isTransientError(error) || attempt === maxRetries) {
        throw error;
      }

      // Check if we should abort before retrying
      if (shouldAbortFn && (await shouldAbortFn())) {
        throw error;
      }

      if (onRetry) {
        await onRetry(error, attempt + 2);
      }

      const delay = baseDelayMs * Math.pow(2, attempt);
      log.warn(`Retrying ${label} (attempt ${attempt + 2}/${maxRetries + 1}) after ${delay}ms: ${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  return runWithLogCallback(options.onLog ?? null, async () => {
    const startedAt = Date.now();
    const resolvedOutput = path.resolve(options.outputDir);
    const statePath = getStateFilePath(resolvedOutput, options.stateFile);
    const memoryLogEveryPages = readPositiveInt("CRAWL_MEMORY_LOG_EVERY_PAGES", DEFAULT_MEMORY_LOG_EVERY_PAGES);
    let peakRssBytes = 0;

    const recordMemorySnapshot = async (
      label: string,
      extra?: Record<string, string | number | boolean | null | undefined>
    ): Promise<void> => {
      const snapshot = captureMemorySnapshot();
      peakRssBytes = Math.max(peakRssBytes, snapshot.rssBytes);
      log.info(formatMemorySnapshot(label, snapshot, peakRssBytes, extra));
      await options.onMemorySnapshot?.(label, snapshot, peakRssBytes);
    };

    try {
      await assertNotAborted(options);
      await recordMemorySnapshot("crawl start", { baseUrl: options.baseUrl });

      // Load existing state if resuming
      let state: CrawlState | null = null;
      if (options.resume || options.retryFailed) {
        state = await loadState(statePath);
        if (state && state.baseUrl !== options.baseUrl) {
          log.warn(`State file contains different baseUrl (${state.baseUrl}), ignoring state`);
          state = null;
        }
      }

      // Only empty directory if not resuming
      if (!options.resume && !options.retryFailed) {
        await fs.emptyDir(resolvedOutput);
        if (await fs.pathExists(statePath)) {
          await fs.remove(statePath);
        }
      }

      await assertNotAborted(options);
      log.info(`Resolving sitemap for ${options.baseUrl}`);
      const sitemapUrls = await fetchSitemapUrls(options.baseUrl);
      const crawlSource = resolveCrawlSource(options.baseUrl, sitemapUrls, options);
      await recordMemorySnapshot("after sitemap resolution", {
        sitemapUrls: sitemapUrls.length,
        usedSitemap: crawlSource.usedSitemap,
      });
      if (crawlSource.usedFallback) {
        log.warn(
          `No sitemap URLs discovered for ${options.baseUrl}; falling back to homepage seed + link discovery`
        );
      }

    // Filter URLs based on exclude patterns
    let filteredUrls = crawlSource.seedUrls;
    if (options.excludePatterns && options.excludePatterns.length > 0) {
      const patterns = options.excludePatterns.map((p) => new RegExp(p));
      filteredUrls = crawlSource.seedUrls.filter((url) => !patterns.some((pattern) => pattern.test(url)));
      if (filteredUrls.length < crawlSource.seedUrls.length) {
        log.info(`Excluded ${crawlSource.seedUrls.length - filteredUrls.length} URLs based on patterns`);
      }
    }

      const allPages = options.maxPages ? filteredUrls.slice(0, options.maxPages) : filteredUrls;
      const pages = filterUrlsForResume(
        allPages,
        state,
        options.resume ?? false,
        options.retryFailed ?? false
      );

      if (pages.length === 0) {
        log.info("No URLs to process (all already completed or no failed URLs to retry).");
        return {
          total: allPages.length,
          succeeded: state?.succeeded.length ?? 0,
          failed: state?.failed.length ?? 0,
          durationMs: Date.now() - startedAt,
        };
      }

      const sourceLabel = crawlSource.usedSitemap ? "sitemap" : "homepage seed";
      log.info(`Found ${pages.length} URLs to crawl (${allPages.length} total from ${sourceLabel}).`);

      if (!state) {
        state = {
          baseUrl: options.baseUrl,
          outputDir: resolvedOutput,
          succeeded: [],
          failed: [],
          lastUpdated: Date.now(),
        };
      }

      const assetCacheEnabled = process.env.ASSET_CACHE_ENABLED === "true";
      let assetCache: AssetCache | undefined;
      if (assetCacheEnabled) {
        const cacheDir = options.assetCacheDir ?? path.join(
          process.env.LOCAL_TEMP_PATH || "/tmp",
          "dxd-asset-cache",
          new URL(options.baseUrl).hostname,
        );
        assetCache = new AssetCache(cacheDir);
        await assetCache.init();
        log.info(`Asset cache enabled at ${cacheDir}`);
      } else {
        log.info("Asset cache disabled (set ASSET_CACHE_ENABLED=true to enable)");
      }

      const assetDownloader = new AssetDownloader(resolvedOutput, assetCache, {
        downloadBlacklist: options.downloadBlacklist,
        globalDownloadBlacklist: options.globalDownloadBlacklist,
        shouldAbort: options.shouldAbort,
      });
      await assetDownloader.init();

      const cpuCount = os.cpus().length;
      const configuredMaxConcurrency = readPositiveInt("MAX_CRAWL_CONCURRENCY", 30);
      const requestedConcurrency = Math.max(1, options.concurrency);

      const memoryBufferBytes = readPositiveInt("CRAWL_MEMORY_BUFFER_GB", 15) * 1024 ** 3 / 10;
      const memoryBytesPerPage = readPositiveInt("CRAWL_MEMORY_MB_PER_PAGE", 150) * 1024 ** 2;
      const memoryBytesPerBrowser = readPositiveInt("CRAWL_MEMORY_MB_PER_BROWSER", 350) * 1024 ** 2;

      const overrideConcurrency = readPositiveInt("CRAWL_OVERRIDE_CONCURRENCY", 0);
      const overrideBrowsers = readPositiveInt("CRAWL_OVERRIDE_BROWSERS", 0);
      const disableResourceChecks = process.env.CRAWL_DISABLE_RESOURCE_CHECKS === "true";
      const pagesPerBrowser = readPositiveInt("CRAWL_PAGES_PER_BROWSER", 6);
      const rssSafetyThresholdPercent = Number.parseFloat(process.env.CRAWL_RSS_SAFETY_THRESHOLD_PERCENT || "0.85");
      const containerMemoryInfo = await readContainerMemoryInfo();
      const runtimePlan = calculateCrawlRuntimePlan({
        requestedConcurrency,
        configuredMaxConcurrency,
        cpuCount,
        hostFreeMemoryBytes: os.freemem(),
        processRssBytes: process.memoryUsage().rss,
        containerLimitBytes: containerMemoryInfo.limitBytes,
        memoryBufferBytes,
        memoryBytesPerPage,
        memoryBytesPerBrowser,
        pagesPerBrowser,
        disableResourceChecks,
        overrideConcurrency,
        overrideBrowsers,
        rssSafetyThresholdPercent,
      });
      const effectiveConcurrency = runtimePlan.effectiveConcurrency;
      const numBrowsers = runtimePlan.numBrowsers;
      const concurrencyPerBrowser = runtimePlan.concurrencyPerBrowser;

      if (effectiveConcurrency < requestedConcurrency && !disableResourceChecks) {
        log.warn(
          `Crawl concurrency reduced from ${requestedConcurrency} to ${effectiveConcurrency} for stability`
        );
      }
      if (overrideConcurrency > 0 && overrideBrowsers > 0) {
        log.info(
          `CRAWL_OVERRIDE_CONCURRENCY=${overrideConcurrency}, CRAWL_OVERRIDE_BROWSERS=${overrideBrowsers} - bypassing resource checks`
        );
      }
      if (runtimePlan.rssSafetyCapApplied) {
        log.warn("Crawl concurrency clamped because RSS is near the container memory ceiling");
      }

      log.info(
        `Runtime plan: ${cpuCount} CPUs, process RSS ${formatMemoryBytes(runtimePlan.processRssBytes)}, ` +
          `${runtimePlan.memorySource} available memory ${formatMemoryBytes(runtimePlan.availableMemoryBytes)}, ` +
          `container limit ${runtimePlan.containerLimitBytes ? formatMemoryBytes(runtimePlan.containerLimitBytes) : "unbounded"}. ` +
          `Launching ${numBrowsers} browser(s) with ${concurrencyPerBrowser} pages each (${effectiveConcurrency} total concurrency)`
      );
      await recordMemorySnapshot("before browser launch", {
        effectiveConcurrency,
        browsers: numBrowsers,
        memorySource: runtimePlan.memorySource,
        containerSource: containerMemoryInfo.source,
      });

      const scopedPages = new Set(allPages);
      const resumedSucceeded = state.succeeded.filter((url) => scopedPages.has(url));
      const resumedFailed = state.failed.filter((url) => scopedPages.has(url) && !resumedSucceeded.includes(url));

      const browsers: Browser[] = [];
      const contexts: BrowserContext[] = [];
      const browserRecoveries: Array<Promise<void> | null> = [];
      const pendingSucceeded: string[] = [];
      const pendingFailed: string[] = [];
      let processed = 0;
      let succeededCount = resumedSucceeded.length;
      let failedCount = resumedFailed.length;

    // B2: Shared work queue — all browsers pull from a single pool
      const visitedUrls = new Set<string>([...state.succeeded, ...state.failed]);
      const urlQueue = [...pages];
      let nextIndex = 0;

    // B7: Link discovery support
      const sitemapOnly = crawlSource.sitemapOnly;
      const discoverLinks = crawlSource.discoverLinks;
      const maxTotalUrls = options.maxPages ?? Infinity;
      const staticFastPath = options.staticFastPath !== false;
      let staticPageCount = 0;

      if (sitemapOnly && options.discoverLinks) {
        log.info("sitemapOnly mode enabled — link discovery disabled");
      }
      if (staticFastPath) {
        log.info("Static fast-path enabled — pages without dynamic content will skip Playwright");
      }

      function getNextUrl(): string | null {
      while (nextIndex < urlQueue.length) {
        const url = urlQueue[nextIndex++];
        if (!visitedUrls.has(url)) {
          visitedUrls.add(url);
          return url;
        }
      }
      return null;
    }

      const flushStateProgress = async (force: boolean): Promise<void> => {
      if (!force && pendingSucceeded.length + pendingFailed.length < STATE_FLUSH_BATCH_SIZE) {
        return;
      }
      if (pendingSucceeded.length === 0 && pendingFailed.length === 0) {
        return;
      }
      const succeededBatch = pendingSucceeded.splice(0, pendingSucceeded.length);
      const failedBatch = pendingFailed.splice(0, pendingFailed.length);
      await updateStateProgress(statePath, state!, succeededBatch, failedBatch);
    };

      const reportProgress = async (currentUrl?: string): Promise<void> => {
      if (!options.onProgress) {
        return;
      }
      const progress: CrawlProgress = {
        total: Math.max(allPages.length, urlQueue.length),
        succeeded: succeededCount,
        failed: failedCount,
        currentUrl,
      };
      await options.onProgress(progress);
    };

      const maxRetries = readPositiveInt("CRAWL_PAGE_MAX_RETRIES", 2);
      const retryBaseDelayMs = readPositiveInt("CRAWL_PAGE_RETRY_DELAY_MS", 2000);
      const pageTimeoutMs = readPositiveInt("CRAWL_PAGE_TIMEOUT_MS", 120000);

      async function recoverBrowserContext(browserIndex: number): Promise<void> {
      if (browserRecoveries[browserIndex]) {
        await browserRecoveries[browserIndex];
        return;
      }

      const recovery = (async () => {
        const oldContext = contexts[browserIndex];
        const oldBrowser = browsers[browserIndex];

        await oldContext?.close().catch(() => undefined);
        await oldBrowser?.close().catch(() => undefined);

        const newBrowser = await chromium.launch({ headless: true });
        const newContext = await newBrowser.newContext();
        browsers[browserIndex] = newBrowser;
        contexts[browserIndex] = newContext;

        log.warn(`Recovered browser ${browserIndex + 1} after unexpected Playwright close.`);
      })();

      browserRecoveries[browserIndex] = recovery;
      try {
        await recovery;
      } finally {
        browserRecoveries[browserIndex] = null;
      }
    }

      try {
      for (let i = 0; i < numBrowsers; i++) {
        await assertNotAborted(options);
        const browser = await chromium.launch({ headless: true });
        browsers.push(browser);
        // B4: Create one context per browser and reuse it
        const context = await browser.newContext();
        contexts.push(context);
      }

      // B2: Shared work queue — each browser worker pulls from the same pool
      await Promise.all(
        browsers.map(async (_browser, browserIndex) => {
          const context = contexts[browserIndex];
          const workerCount = Math.max(1, Math.min(concurrencyPerBrowser, urlQueue.length));

          const workers = Array.from({ length: workerCount }, async () => {
            while (true) {
              try {
                await assertNotAborted(options);
              } catch (error) {
                if (isAbortError(error)) {
                  return; // Graceful exit on abort
                }
                throw error;
              }

              const url = getNextUrl();
              if (!url) return;

              const position = ++processed;
              await reportProgress(url);

              try {
                // B3: Retry with exponential backoff + overall page timeout
                const pageResult = await withRetry(
                  () => withTimeout(
                    () => processPage({
                      url,
                      context,
                      outputDir: resolvedOutput,
                      assets: assetDownloader,
                      removeWebflowBadge: options.removeWebflowBadge ?? true,
                      tryStaticFirst: staticFastPath,
                      sitemapOnly,
                      shouldAbort: options.shouldAbort,
                      signal: options.signal,
                    }),
                    pageTimeoutMs,
                    `Page processing for ${url}`
                  ),
                  maxRetries,
                  retryBaseDelayMs,
                  url,
                  options.shouldAbort,
                  async (retryError) => {
                    if (isPlaywrightClosedError(retryError)) {
                      await recoverBrowserContext(browserIndex);
                    }
                  }
                );

                const { relativePath, html } = pageResult;
                if (pageResult.static) {
                  staticPageCount += 1;
                }

                succeededCount += 1;
                pendingSucceeded.push(url);

                // B7: Discover new URLs from the crawled page
                if (discoverLinks && html && urlQueue.length < maxTotalUrls) {
                  const discovered = extractLinks(html, url, options.baseUrl);
                  for (const newUrl of discovered) {
                    if (!visitedUrls.has(newUrl) && urlQueue.length < maxTotalUrls) {
                      urlQueue.push(newUrl);
                    }
                  }
                }

                if (position % memoryLogEveryPages === 0) {
                  await recordMemorySnapshot("during crawl", {
                    processed: position,
                    queued: urlQueue.length,
                    succeeded: succeededCount,
                    failed: failedCount,
                  });
                }

                if (position % 25 === 0 || position === pages.length) {
                  const inFlight = position - succeededCount - failedCount;
                  const inFlightMsg = inFlight > 0 ? `, ${inFlight} in progress` : "";
                  log.info(
                    `Progress: ${position}/${urlQueue.length} processed (${succeededCount} succeeded, ${failedCount} failed${inFlightMsg})`
                  );
                } else {
                  log.debug(`Archived ${url} -> ${relativePath}`, url);
                }
              } catch (error) {
                if (isAbortError(error)) {
                  throw error;
                }
                failedCount += 1;
                pendingFailed.push(url);
                log.error(`(${position}/${urlQueue.length}) Failed ${url}: ${(error as Error).message}`, url);
              }

              await flushStateProgress(false);
            }
          });

          await Promise.all(workers);
        })
      );
      } finally {
      // B4: Close contexts, then browsers
      await Promise.all(
        contexts.map(async (ctx) => {
          await ctx.close().catch(() => undefined);
        })
      );
      await Promise.all(
        browsers.map(async (browser) => {
          await browser.close().catch(() => undefined);
        })
      );
    }

      await assertNotAborted(options);
      await flushStateProgress(true);
      await writeOutputConfig(resolvedOutput, options.redirectsCsv);
      await reportProgress();

      let cacheHitRate = "n/a";
      if (assetCache) {
        await assetCache.evict();
        const cacheStats = assetCache.getStats();
        cacheHitRate = cacheStats.hitRate;
        log.info(
          `Asset cache: ${cacheStats.hits} hits, ${cacheStats.misses} misses (${cacheStats.hitRate} hit rate)`,
        );
      }

      if (staticPageCount > 0) {
        log.info(
          `Static fast-path: ${staticPageCount}/${succeededCount} pages processed without Playwright`,
        );
      }
      await recordMemorySnapshot("crawl complete", {
        total: Math.max(allPages.length, urlQueue.length),
        succeeded: succeededCount,
        failed: failedCount,
      });

      return {
        total: Math.max(allPages.length, urlQueue.length),
        succeeded: succeededCount,
        failed: failedCount,
        durationMs: Date.now() - startedAt,
        staticPages: staticPageCount,
        cacheHitRate,
      };
    } catch (error) {
      await recordMemorySnapshot("crawl failure", {
        message: error instanceof Error ? error.message : "unknown-error",
      });
      throw error;
    }
  });
}
