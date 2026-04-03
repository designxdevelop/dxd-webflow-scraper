/** Thrown when a crawl is cancelled (including user cancellation or record deletion). */
export class CrawlCancelledError extends Error {
  constructor(message = "Crawl cancelled by user") {
    super(message);
    this.name = "CrawlCancelledError";
  }
}

/** Thrown when a crawl exceeds its max-duration budget. */
export class CrawlTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrawlTimeoutError";
  }
}
