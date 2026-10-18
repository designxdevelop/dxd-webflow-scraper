import { and, eq, inArray, lte } from "drizzle-orm";
import type { Database } from "./db/client.js";
import { crawls, sitePublications, sites } from "./db/schema.js";
import { getNextScheduledAt } from "./routes/sites.utils.js";

const ACTIVE_CRAWL_STATUSES = ["pending", "running", "archiving", "uploading"];

/**
 * Cron tick (every minute): create crawls for due schedules, then wake the crawler if any
 * work is outstanding. Waking a running container just renews its activity timeout; waking
 * it when a row is stuck "running" restarts it, and the new instance fails the orphan.
 */
export async function runScheduledTick(db: Database, kick: () => Promise<void>): Promise<void> {
  const now = new Date();
  const dueSites = await db.query.sites.findMany({
    where: and(eq(sites.scheduleEnabled, true), lte(sites.nextScheduledAt, now)),
  });

  for (const site of dueSites) {
    // Compare-and-set so overlapping ticks can't schedule the same run twice.
    const claimed = await db
      .update(sites)
      .set({ nextScheduledAt: getNextScheduledAt(true, site.scheduleCron) })
      .where(and(eq(sites.id, site.id), eq(sites.nextScheduledAt, site.nextScheduledAt!)))
      .returning({ id: sites.id });
    if (claimed.length === 0) continue;

    const existing = await db.query.crawls.findFirst({
      where: and(eq(crawls.siteId, site.id), inArray(crawls.status, ACTIVE_CRAWL_STATUSES)),
    });
    if (existing) {
      console.log(`[Scheduler] Skipping ${site.name}; crawl already ${existing.status}`);
      continue;
    }

    await db.insert(crawls).values({ siteId: site.id, status: "pending" });
    console.log(`[Scheduler] Queued scheduled crawl for ${site.name}`);
  }

  const activeCrawl = await db.query.crawls.findFirst({
    where: inArray(crawls.status, ACTIVE_CRAWL_STATUSES),
    columns: { id: true },
  });
  const pendingPublication = await db.query.sitePublications.findFirst({
    where: inArray(sitePublications.status, ["pending", "publishing"]),
    columns: { id: true },
  });
  if (activeCrawl || pendingPublication) {
    await kick();
  }
}
