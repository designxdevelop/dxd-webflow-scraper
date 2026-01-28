// Main exports
export { crawlSite } from "./crawler.js";
export { fetchSitemapUrls } from "./sitemap-parser.js";
export { writeOutputConfig } from "./output-config.js";

// Types
export type {
  ScrapeConfig,
  CrawlOptions,
  CrawlResult,
  CrawlProgress,
  CrawlState,
  AssetCategory,
  LogLevel,
} from "./types.js";

// Utilities (for advanced usage)
export { AssetDownloader } from "./asset-downloader.js";
export { rewriteHtmlDocument } from "./url-rewriter.js";
export { processPage, buildRelativeFilePath } from "./page-processor.js";
export { setLogCallback } from "./logger.js";
export {
  getStateFilePath,
  loadState,
  saveState,
  updateStateProgress,
  filterUrlsForResume,
} from "./state-manager.js";
