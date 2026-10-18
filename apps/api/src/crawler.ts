import { Container } from "@cloudflare/containers";
import type { Env } from "./index.js";

// Env passed through to the crawler process (services/worker).
const PASSTHROUGH_ENV = [
  "CRAWLER_OWNS_QUEUE",
  "STORAGE_TYPE",
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_REGION",
  "R2_FORCE_PATH_STYLE",
  "CRAWL_MAX_DURATION_MS",
  "MAX_SITE_CONCURRENCY",
  "ARCHIVE_UPLOAD_TIMEOUT_MS",
  "ARCHIVE_ZLIB_LEVEL",
] as const;

/**
 * Singleton crawler container. It has no HTTP server: it drains the Postgres queue and exits,
 * which stops the container (and billing). sleepAfter is only a safety ceiling; kicks while it
 * is running renew it.
 */
export class Crawler extends Container<Env> {
  sleepAfter = "2h";

  async kick(crawlId?: string): Promise<void> {
    if (this.ctx.container?.running) {
      this.renewActivityTimeout();
      return;
    }

    const envVars: Record<string, string> = { DATABASE_URL: this.env.CRAWLER_DATABASE_URL };
    for (const key of PASSTHROUGH_ENV) {
      const value = this.env[key];
      if (value) envVars[key] = value;
    }
    if (crawlId) envVars.CRAWL_ID = crawlId;

    await this.start({ envVars });
  }

  override onStop(params: { exitCode?: number; reason?: string }) {
    console.log(`[Crawler] container stopped`, params);
  }
}
