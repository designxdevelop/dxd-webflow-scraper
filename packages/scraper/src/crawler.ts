import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import pLimit from "p-limit";
import { chromium, Browser } from "playwright";
import { fetchSitemapUrls } from "./sitemap-parser.js";
import { AssetDownloader } from "./asset-downloader.js";
import { processPage } from "./page-processor.js";
import { CrawlOptions, CrawlResult, CrawlState, CrawlProgress } from "./types.js";
import { log, setLogCallback } from "./logger.js";
import { writeOutputConfig } from "./output-config.js";
import {
  getStateFilePath,
  loadState,
  saveState,
  updateStateProgress,
  filterUrlsForResume,
} from "./state-manager.js";

export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const startedAt = Date.now();
  const resolvedOutput = path.resolve(options.outputDir);
  const statePath = getStateFilePath(resolvedOutput, options.stateFile);

  // Set up log callback if provided
  if (options.onLog) {
    setLogCallback(options.onLog);
  }

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
    // Clear state for fresh start
    if (await fs.pathExists(statePath)) {
      await fs.remove(statePath);
    }
  }

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

  // Filter URLs based on resume/retry options
  const pages = filterUrlsForResume(allPages, state, options.resume ?? false, options.retryFailed ?? false);

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

  // Initialize or update state
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

  // Calculate browser capacity based on system resources
  // Each browser instance uses ~200-500MB RAM, so check available memory
  const totalMemoryGB = os.totalmem() / 1024 ** 3;
  const freeMemoryGB = os.freemem() / 1024 ** 3;
  const cpuCount = os.cpus().length;

  // Estimate: each browser instance needs ~300MB, leave 2GB for system
  const maxBrowsersByMemory = Math.floor((freeMemoryGB - 2) / 0.3);
  const maxBrowsersByCPU = cpuCount;

  // Use multiple browser instances for better parallelism
  // Each browser instance runs in its own process, utilizing multiple CPU cores
  // Only use multiple browsers if concurrency is high enough to benefit
  const desiredBrowsers = options.concurrency >= 4 ? Math.max(2, Math.ceil(options.concurrency / 3)) : 1;

  // Cap by available resources (CPU and memory), ensure at least 1 browser
  const numBrowsers = Math.max(1, Math.min(desiredBrowsers, maxBrowsersByCPU, Math.max(1, maxBrowsersByMemory)));

  const concurrencyPerBrowser = Math.max(1, Math.ceil(options.concurrency / numBrowsers));

  log.info(
    `System capacity: ${cpuCount} CPUs, ${freeMemoryGB.toFixed(1)}GB free memory. ` +
      `Launching ${numBrowsers} browser instance(s) with ${concurrencyPerBrowser} concurrent pages each`
  );

  const browsers: Browser[] = [];
  let succeededUrls: string[] = [];
  let failedUrls: string[] = [];

  try {
    // Launch all browser instances
    for (let i = 0; i < numBrowsers; i++) {
      browsers.push(await chromium.launch({ headless: true }));
    }

    // Distribute pages across browser instances using round-robin
    const browserQueues: string[][] = Array.from({ length: numBrowsers }, () => []);
    pages.forEach((url, index) => {
      browserQueues[index % numBrowsers].push(url);
    });

    let processed = 0;
    const urlResults: Array<{ url: string; success: boolean; relativePath?: string; error?: string }> = [];

    // Process each browser's queue in parallel
    await Promise.all(
      browsers.map((browser, browserIndex) => {
        const queue = browserQueues[browserIndex];
        const limit = pLimit(concurrencyPerBrowser);

        return Promise.all(
          queue.map((url) =>
            limit(async () => {
              const position = ++processed;
              
              // Report progress
              if (options.onProgress) {
                const progress: CrawlProgress = {
                  total: pages.length,
                  succeeded: urlResults.filter((r) => r.success).length,
                  failed: urlResults.filter((r) => !r.success).length,
                  currentUrl: url,
                };
                await options.onProgress(progress);
              }

              try {
                const relativePath = await processPage({
                  url,
                  browser,
                  outputDir: resolvedOutput,
                  assets: assetDownloader,
                  removeWebflowBadge: options.removeWebflowBadge ?? true,
                });
                urlResults.push({ url, success: true, relativePath });
                log.info(`(${position}/${pages.length}) Archived ${url} -> ${relativePath}`, url);
              } catch (error) {
                urlResults.push({ url, success: false, error: (error as Error).message });
                log.error(`(${position}/${pages.length}) Failed ${url}: ${(error as Error).message}`, url);
              }
            })
          )
        );
      })
    );

    // Collect results
    succeededUrls = urlResults.filter((r) => r.success).map((r) => r.url!);
    failedUrls = urlResults.filter((r) => !r.success).map((r) => r.url!);
  } finally {
    // Close all browser instances
    await Promise.all(browsers.map((browser) => browser.close()));
    
    // Clear log callback
    setLogCallback(null);
  }

  // Update state with progress
  if (succeededUrls.length > 0 || failedUrls.length > 0) {
    await updateStateProgress(statePath, state, succeededUrls, failedUrls);
  }

  // Write output config (vercel.json by default)
  await writeOutputConfig(resolvedOutput, options.redirectsCsv);

  const totalSucceeded = state.succeeded.length;
  const totalFailed = state.failed.length;

  // Final progress report
  if (options.onProgress) {
    await options.onProgress({
      total: allPages.length,
      succeeded: totalSucceeded,
      failed: totalFailed,
    });
  }

  return {
    total: allPages.length,
    succeeded: totalSucceeded,
    failed: totalFailed,
    durationMs: Date.now() - startedAt,
  };
}
