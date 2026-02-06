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
  removeWebflowBadge?: boolean;
  resume?: boolean;
  retryFailed?: boolean;
  stateFile?: string;
  redirectsCsv?: string;
  /** Enable link-based URL discovery from crawled pages (spider mode). */
  discoverLinks?: boolean;
  signal?: AbortSignal;
  shouldAbort?: () => boolean | Promise<boolean>;
  onProgress?: (progress: CrawlProgress) => void | Promise<void>;
  onLog?: (level: LogLevel, message: string, url?: string) => void | Promise<void>;
}

export interface PageResult {
  relativePath: string;
  html: string;
}
