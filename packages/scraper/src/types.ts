export type AssetCategory = "css" | "js" | "image" | "font" | "media" | "html";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface CrawlProgress {
  total: number;
  succeeded: number;
  failed: number;
  currentUrl?: string;
}

export interface ScrapeConfig {
  baseUrl: string;
  outputDir: string;
  concurrency?: number;
  maxPages?: number;
  excludePatterns?: string[];
  downloadBlacklist?: string[];
  globalDownloadBlacklist?: string[];
  removeWebflowBadge?: boolean;
  redirectsCsv?: string;

  // Progress callbacks
  onProgress?: (progress: CrawlProgress) => void | Promise<void>;
  onLog?: (level: LogLevel, message: string, url?: string) => void | Promise<void>;
}

export interface CrawlResult {
  total: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  /** Number of pages processed via the static fast-path (no Playwright). */
  staticPages?: number;
  /** Asset cache hit rate for this crawl (e.g. "45.2%"). */
  cacheHitRate?: string;
}

export interface CrawlState {
  baseUrl: string;
  outputDir: string;
  succeeded: string[];
  failed: string[];
  lastUpdated: number;
}

export interface CrawlOptions {
  baseUrl: string;
  outputDir: string;
  concurrency: number;
  maxPages?: number;
  excludePatterns?: string[];
  downloadBlacklist?: string[];
  globalDownloadBlacklist?: string[];
  removeWebflowBadge?: boolean;
  resume?: boolean;
  retryFailed?: boolean;
  stateFile?: string;
  redirectsCsv?: string;
  /** Enable link-based URL discovery from crawled pages (spider mode). */
  discoverLinks?: boolean;
  /** Try static HTML analysis before falling back to Playwright.
   *  Pages without dynamic content indicators are processed via fetch+Cheerio. Defaults to true. */
  staticFastPath?: boolean;
  /** Trust the sitemap as the complete URL list and optimise processing.
   *  Disables link discovery and reduces dynamic content trigger timeouts. Defaults to true. */
  sitemapOnly?: boolean;
  /** Custom directory for the cross-crawl asset cache.
   *  Defaults to {LOCAL_TEMP_PATH}/dxd-asset-cache/{hostname}. */
  assetCacheDir?: string;
  signal?: AbortSignal;
  shouldAbort?: () => boolean | Promise<boolean>;
  onProgress?: (progress: CrawlProgress) => void | Promise<void>;
  onLog?: (level: LogLevel, message: string, url?: string) => void | Promise<void>;
}

export interface PageResult {
  relativePath: string;
  html: string;
  /** Whether the page was processed via the static fast-path (no Playwright). */
  static?: boolean;
}

/** Result of scanning HTML for dynamic content indicators. */
export interface DynamicContentDetection {
  isDynamic: boolean;
  reasons: string[];
}
