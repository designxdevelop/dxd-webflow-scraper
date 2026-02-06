import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { chromium, Browser, BrowserContext } from "playwright";
import { fetchSitemapUrls } from "./sitemap-parser.js";
import { AssetDownloader } from "./asset-downloader.js";
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
const STATE_FLUSH_BATCH_SIZE = 100;

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
    msg.includes("429")
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
  shouldAbortFn?: () => boolean | Promise<boolean>
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

    const assetDownloader = new AssetDownloader(resolvedOutput);
    await assetDownloader.init();

    const freeMemoryGB = os.freemem() / 1024 ** 3;
    const cpuCount = os.cpus().length;
    const configuredMaxConcurrency = readPositiveInt("MAX_CRAWL_CONCURRENCY", 10);
    const requestedConcurrency = Math.max(1, options.concurrency);
    const maxConcurrencyByMemory = Math.max(1, Math.floor(Math.max(0.5, freeMemoryGB - 1.5) / 0.25));
    const effectiveConcurrency = Math.max(
      1,
      Math.min(requestedConcurrency, configuredMaxConcurrency, cpuCount * 2, maxConcurrencyByMemory)
    );

    if (effectiveConcurrency < requestedConcurrency) {
      log.warn(
        `Crawl concurrency reduced from ${requestedConcurrency} to ${effectiveConcurrency} for stability`
      );
    }

    const maxBrowsersByMemory = Math.max(1, Math.floor(Math.max(0.5, freeMemoryGB - 1.5) / 0.35));
    const maxBrowsersByCPU = Math.max(1, Math.floor(cpuCount));
    const desiredBrowsers =
      effectiveConcurrency >= 4 ? Math.max(2, Math.ceil(effectiveConcurrency / 3)) : 1;
    const numBrowsers = Math.max(
      1,
      Math.min(desiredBrowsers, maxBrowsersByCPU, maxBrowsersByMemory)
    );
    const concurrencyPerBrowser = Math.max(1, Math.ceil(effectiveConcurrency / numBrowsers));

    log.info(
      `System capacity: ${cpuCount} CPUs, ${freeMemoryGB.toFixed(1)}GB free memory. ` +
        `Launching ${numBrowsers} browser instance(s) with ${concurrencyPerBrowser} concurrent pages each`
    );

    const browsers: Browser[] = [];
    const contexts: BrowserContext[] = [];
    const pendingSucceeded: string[] = [];
    const pendingFailed: string[] = [];
    let processed = 0;
    let succeededCount = state.succeeded.length;
    let failedCount = state.failed.length;

    // B2: Shared work queue — all browsers pull from a single pool
    const visitedUrls = new Set<string>([...state.succeeded, ...state.failed]);
    const urlQueue = [...pages];
    let nextIndex = 0;

    // B7: Link discovery support
    const discoverLinks = options.discoverLinks ?? false;
    const maxTotalUrls = options.maxPages ?? Infinity;

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
        browsers.map(async (browser, browserIndex) => {
          const context = contexts[browserIndex];
          const workerCount = Math.max(1, Math.min(concurrencyPerBrowser, urlQueue.length));

          const workers = Array.from({ length: workerCount }, async () => {
            while (true) {
              await assertNotAborted(options);

              const url = getNextUrl();
              if (!url) return;

              const position = ++processed;
              await reportProgress(url);

              try {
                // B3: Retry with exponential backoff
                const { relativePath, html } = await withRetry(
                  () => processPage({
                    url,
                    context,
                    outputDir: resolvedOutput,
                    assets: assetDownloader,
                    removeWebflowBadge: options.removeWebflowBadge ?? true,
                    shouldAbort: options.shouldAbort,
                    signal: options.signal,
                  }),
                  maxRetries,
                  retryBaseDelayMs,
                  url,
                  options.shouldAbort
                );

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
                  log.info(
                    `Progress: ${position}/${urlQueue.length} processed (${succeededCount} succeeded, ${failedCount} failed)`
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

    return {
      total: Math.max(allPages.length, urlQueue.length),
      succeeded: succeededCount,
      failed: failedCount,
      durationMs: Date.now() - startedAt,
    };
  });
}
