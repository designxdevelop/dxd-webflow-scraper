import cron from "node-cron";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { eq, and, lte, inArray } from "drizzle-orm";
import { db, sites, crawls } from "./db.js";
import cronParser from "cron-parser";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

const schedulerLockKey = "scheduler:crawl-check";

async function acquireSchedulerLock(): Promise<boolean> {
  try {
    const result = await redis.set(schedulerLockKey, Date.now().toString(), "EX", 55, "NX");
    return result === "OK";
  } catch {
    return false;
  }
}

const crawlQueue = new Queue("crawl-jobs", {
  connection: redis,
});

async function checkScheduledCrawls() {
  try {
    const hasLock = await acquireSchedulerLock();
    if (!hasLock) {
      return;
    }

    // Find sites that are due for a crawl
    const dueSites = await db.query.sites.findMany({
      where: and(eq(sites.scheduleEnabled, true), lte(sites.nextScheduledAt, new Date())),
    });

    for (const site of dueSites) {
      const existing = await db.query.crawls.findFirst({
        where: and(
          eq(crawls.siteId, site.id),
          inArray(crawls.status, ["pending", "running", "uploading"])
        ),
      });

      if (existing) {
        console.log(
          `[Scheduler] Skipping ${site.name}; crawl already ${existing.status} (${existing.id})`
        );
        continue;
      }

      console.log(`[Scheduler] Starting scheduled crawl for site: ${site.name}`);

      // Create new crawl
      const [crawl] = await db
        .insert(crawls)
        .values({
          siteId: site.id,
          status: "pending",
        })
        .returning();

      // Queue the job
      await crawlQueue.add(
        "crawl",
        {
          siteId: site.id,
          crawlId: crawl.id,
        },
        {
          jobId: crawl.id,
        }
      );

      // Calculate next run time
      if (site.scheduleCron) {
        try {
          const interval = cronParser.parse(site.scheduleCron);
          const nextRun = interval.next().toDate();

          await db
            .update(sites)
            .set({ nextScheduledAt: nextRun })
            .where(eq(sites.id, site.id));

          console.log(`[Scheduler] Next run for ${site.name}: ${nextRun.toISOString()}`);
        } catch (error) {
          console.error(
            `[Scheduler] Invalid cron expression for site ${site.name}: ${site.scheduleCron}`
          );
        }
      }
    }
  } catch (error) {
    console.error("[Scheduler] Error checking scheduled crawls:", error);
  }
}

export function startScheduler() {
  // Check for due schedules every minute
  cron.schedule("* * * * *", async () => {
    await checkScheduledCrawls();
  });

  console.log("[Scheduler] Started schedule checker (runs every minute)");

  // Run initial check
  checkScheduledCrawls();
}
