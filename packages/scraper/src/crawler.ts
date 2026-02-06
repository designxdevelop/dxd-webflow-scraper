import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { chromium, Browser } from "playwright";
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
    const pendingSucceeded: string[] = [];
    const pendingFailed: string[] = [];
    let processed = 0;
    let succeededCount = state.succeeded.length;
    let failedCount = state.failed.length;

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
        total: allPages.length,
        succeeded: succeededCount,
        failed: failedCount,
        currentUrl,
      };
      await options.onProgress(progress);
    };

    try {
      for (let i = 0; i < numBrowsers; i++) {
        await assertNotAborted(options);
        browsers.push(await chromium.launch({ headless: true }));
      }

      const browserQueues: string[][] = Array.from({ length: numBrowsers }, () => []);
      pages.forEach((url, index) => {
        browserQueues[index % numBrowsers].push(url);
      });

      await Promise.all(
        browsers.map(async (browser, browserIndex) => {
          const queue = browserQueues[browserIndex];
          let nextIndex = 0;
          const workerCount = Math.max(1, Math.min(concurrencyPerBrowser, queue.length));

          const workers = Array.from({ length: workerCount }, async () => {
            while (true) {
              await assertNotAborted(options);

              const queueIndex = nextIndex++;
              if (queueIndex >= queue.length) {
                return;
              }

              const url = queue[queueIndex];
              const position = ++processed;
              await reportProgress(url);

              try {
                const relativePath = await processPage({
                  url,
                  browser,
                  outputDir: resolvedOutput,
                  assets: assetDownloader,
                  removeWebflowBadge: options.removeWebflowBadge ?? true,
                  shouldAbort: options.shouldAbort,
                  signal: options.signal,
                });

                succeededCount += 1;
                pendingSucceeded.push(url);

                if (position % 25 === 0 || position === pages.length) {
                  log.info(
                    `Progress: ${position}/${pages.length} processed (${succeededCount} succeeded, ${failedCount} failed)`
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
                log.error(`(${position}/${pages.length}) Failed ${url}: ${(error as Error).message}`, url);
              }

              await flushStateProgress(false);
            }
          });

          await Promise.all(workers);
        })
      );
    } finally {
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
      total: allPages.length,
      succeeded: succeededCount,
      failed: failedCount,
      durationMs: Date.now() - startedAt,
    };
  });
}
