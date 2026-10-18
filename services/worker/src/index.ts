import { sql } from "drizzle-orm";
import { db } from "./db.js";
import { processCrawlJob, processPublicationJob } from "./processor.js";

// Runs inside a Cloudflare Container started on demand by the API Worker.
// Postgres is the queue: claim a row, process it, repeat, then exit so the container stops.
//
// CRAWL_ID: process just this crawl (used for "Run now").
// CRAWLER_OWNS_QUEUE=true: also drain every pending crawl/publication and fail crawls
//   orphaned by a previous container. Keep false while the Railway worker is still running.

const ownsQueue = process.env.CRAWLER_OWNS_QUEUE === "true";
const requestedCrawlId = process.env.CRAWL_ID || null;

type Claimed = { id: string; site_id: string; crawl_id?: string };

async function claimOne(query: ReturnType<typeof sql>): Promise<Claimed | null> {
  const rows = (await db.execute(query)) as unknown as Claimed[];
  return rows[0] ?? null;
}

const claimCrawl = (id: string | null) =>
  claimOne(sql`
    UPDATE crawls SET status = 'running', started_at = COALESCE(started_at, now())
    WHERE id = (
      SELECT id FROM crawls
      WHERE status = 'pending' AND (${id}::uuid IS NULL OR id = ${id}::uuid)
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id, site_id`);

const claimPublication = () =>
  claimOne(sql`
    UPDATE site_publications SET status = 'publishing', updated_at = now()
    WHERE id = (
      SELECT id FROM site_publications WHERE status = 'pending'
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id, site_id, crawl_id`);

async function runCrawl(row: Claimed) {
  try {
    await processCrawlJob({ siteId: row.site_id, crawlId: row.id });
  } catch (error) {
    console.error(`[Worker] Crawl ${row.id} failed`, error);
  }
}

async function main() {
  if (ownsQueue) {
    // Singleton container: anything still active at startup belongs to a dead instance.
    await db.execute(sql`
      UPDATE crawls SET status = 'failed', completed_at = now(),
        error_message = 'Crawler restarted while this crawl was in progress'
      WHERE status IN ('running', 'archiving', 'uploading')`);
    await db.execute(sql`
      UPDATE site_publications SET status = 'failed', updated_at = now(),
        error_message = 'Crawler restarted while publishing'
      WHERE status = 'publishing'`);
  }

  if (requestedCrawlId) {
    const row = await claimCrawl(requestedCrawlId);
    if (row) await runCrawl(row);
  }

  while (ownsQueue) {
    const publication = await claimPublication();
    if (publication) {
      await processPublicationJob({
        siteId: publication.site_id,
        crawlId: publication.crawl_id!,
        publicationId: publication.id,
        activate: true,
      }).catch((error) => console.error(`[Worker] Publication ${publication.id} failed`, error));
      continue;
    }

    const crawl = await claimCrawl(null);
    if (!crawl) break;
    await runCrawl(crawl);
  }

  console.log("[Worker] Queue drained, exiting");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[Worker] Fatal error", error);
    process.exit(1);
  });
