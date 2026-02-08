import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { chromium, Browser, BrowserContext } from "playwright";
import { fetchSitemapUrls } from "./sitemap-parser.js";
import { AssetDownloader } from "./asset-downloader.js";
import { AssetCache } from "./asset-cache.js";
import { processPage } from "./page-processor.js";
import { CrawlOptions, CrawlResult, CrawlState, CrawlProgress } from "./types.js";
import { log, runWithLogCallback } from "./logger.js";
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

function readPositiveInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

    await assertNotAborted(options);

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
    if (!sitemapUrls.length) {
      throw new Error("No URLs discovered from sitemap.");
    }

    // Filter URLs based on exclude patterns
    let filteredUrls = sitemapUrls;
    if (options.excludePatterns && options.excludePatterns.length > 0) {
      const patterns = options.excludePatterns.map((p) => new RegExp(p));
      filteredUrls = sitemapUrls.filter((url) => !patterns.some((pattern) => pattern.test(url)));
      if (filteredUrls.length < sitemapUrls.length) {
        log.info(`Excluded ${sitemapUrls.length - filteredUrls.length} URLs based on patterns`);
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

    log.info(`Found ${pages.length} URLs to crawl (${allPages.length} total in sitemap).`);

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
      // Cross-crawl asset cache scoped by hostname for isolation
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

    const freeMemoryGB = os.freemem() / 1024 ** 3;
    const cpuCount = os.cpus().length;
    const configuredMaxConcurrency = readPositiveInt("MAX_CRAWL_CONCURRENCY", 30);
    const requestedConcurrency = Math.max(1, options.concurrency);

    // Resource calculation parameters (overrideable via env)
    const memoryBufferGB = readPositiveInt("CRAWL_MEMORY_BUFFER_GB", 15) / 10; // Default 1.5GB
    const memoryMBPerPage = readPositiveInt("CRAWL_MEMORY_MB_PER_PAGE", 150);
    const memoryMBPerBrowser = readPositiveInt("CRAWL_MEMORY_MB_PER_BROWSER", 350);

    // Dynamic boost: override concurrency and browsers via env
    const overrideConcurrency = readPositiveInt("CRAWL_OVERRIDE_CONCURRENCY", 0);
    const overrideBrowsers = readPositiveInt("CRAWL_OVERRIDE_BROWSERS", 0);
    const disableResourceChecks = process.env.CRAWL_DISABLE_RESOURCE_CHECKS === "true";

    let effectiveConcurrency: number;
    let numBrowsers: number;

    if (overrideConcurrency > 0 && overrideBrowsers > 0) {
      // Fully manual override - bypass all resource checks
      effectiveConcurrency = overrideConcurrency;
      numBrowsers = overrideBrowsers;
      log.info(
        `CRAWL_OVERRIDE_CONCURRENCY=${overrideConcurrency}, CRAWL_OVERRIDE_BROWSERS=${overrideBrowsers} - bypassing resource checks`
      );
    } else {
      // Calculate based on resources
      const memoryGBPerPage = memoryMBPerPage / 1024;
      const memoryGBPerBrowser = memoryMBPerBrowser / 1024;
      const maxConcurrencyByMemory = Math.max(
        1,
        Math.floor(Math.max(0.5, freeMemoryGB - memoryBufferGB) / memoryGBPerPage)
      );

      effectiveConcurrency = disableResourceChecks
        ? Math.min(requestedConcurrency, configuredMaxConcurrency)
        : Math.max(
            1,
            Math.min(
              requestedConcurrency,
              configuredMaxConcurrency,
              cpuCount * 2,
              maxConcurrencyByMemory
            )
          );

      if (effectiveConcurrency < requestedConcurrency && !disableResourceChecks) {
        log.warn(
          `Crawl concurrency reduced from ${requestedConcurrency} to ${effectiveConcurrency} for stability`
        );
      }

      const maxBrowsersByMemory = Math.max(
        1,
        Math.floor(Math.max(0.5, freeMemoryGB - memoryBufferGB) / memoryGBPerBrowser)
      );
      const maxBrowsersByCPU = Math.max(1, Math.floor(cpuCount));
      const pagesPerBrowser = readPositiveInt("CRAWL_PAGES_PER_BROWSER", 6);
      const desiredBrowsers =
        effectiveConcurrency >= 4 ? Math.max(2, Math.ceil(effectiveConcurrency / pagesPerBrowser)) : 1;

      if (overrideBrowsers > 0) {
        numBrowsers = overrideBrowsers;
      } else {
        numBrowsers = disableResourceChecks
          ? desiredBrowsers
          : Math.max(1, Math.min(desiredBrowsers, maxBrowsersByCPU, maxBrowsersByMemory));
      }
    }

    const concurrencyPerBrowser = Math.max(1, Math.ceil(effectiveConcurrency / numBrowsers));

    log.info(
      `System: ${cpuCount} CPUs, ${freeMemoryGB.toFixed(1)}GB free. ` +
        `Launching ${numBrowsers} browser(s) with ${concurrencyPerBrowser} pages each ` +
        `(${effectiveConcurrency} total concurrency)`
    );

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
    const sitemapOnly = options.sitemapOnly !== false;
    const discoverLinks = sitemapOnly ? false : (options.discoverLinks ?? false);
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
                // B3: Retry with exponential backoff
                const pageResult = await withRetry(
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
      // Evict stale entries from the cross-crawl asset cache
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

    return {
      total: Math.max(allPages.length, urlQueue.length),
      succeeded: succeededCount,
      failed: failedCount,
      durationMs: Date.now() - startedAt,
      staticPages: staticPageCount,
      cacheHitRate,
    };
  });
}
