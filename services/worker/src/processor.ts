import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { eq } from "drizzle-orm";
import { crawlSite, type CrawlProgress, type LogLevel } from "@dxd/scraper";
import { db, sites, crawls, crawlLogs } from "./db.js";
import path from "node:path";
import fs from "node:fs/promises";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const storagePath = process.env.LOCAL_STORAGE_PATH || "./data";

// Redis for pub/sub
const pubClient = new Redis(redisUrl);

// Redis connection for worker
const workerConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

interface CrawlJobData {
  siteId: string;
  crawlId: string;
}

async function publishEvent(crawlId: string, event: object) {
  await pubClient.publish(`crawl:${crawlId}`, JSON.stringify(event));
}

async function processCrawlJob(job: Job<CrawlJobData>) {
  const { siteId, crawlId } = job.data;

  console.log(`[Worker] Starting crawl job: ${crawlId} for site: ${siteId}`);

  // Get site config
  const site = await db.query.sites.findFirst({
    where: eq(sites.id, siteId),
  });

  if (!site) {
    throw new Error(`Site not found: ${siteId}`);
  }

  // Update status to running
  await db
    .update(crawls)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(crawls.id, crawlId));

  await publishEvent(crawlId, {
    type: "log",
    level: "info",
    message: `Starting crawl of ${site.url}`,
    timestamp: new Date().toISOString(),
  });

  // Create output directory
  const outputDir = path.join(storagePath, "temp", crawlId);
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const result = await crawlSite({
      baseUrl: site.url,
      outputDir,
      concurrency: site.concurrency ?? 5,
      maxPages: site.maxPages ?? undefined,
      excludePatterns: site.excludePatterns ?? undefined,
      removeWebflowBadge: site.removeWebflowBadge ?? true,
      redirectsCsv: site.redirectsCsv ?? undefined,

      onProgress: async (progress: CrawlProgress) => {
        // Publish to Redis for SSE
        await publishEvent(crawlId, {
          type: "progress",
          ...progress,
        });

        // Update database
        await db
          .update(crawls)
          .set({
            totalPages: progress.total,
            succeededPages: progress.succeeded,
            failedPages: progress.failed,
          })
          .where(eq(crawls.id, crawlId));
      },

      onLog: async (level: LogLevel, message: string, url?: string) => {
        // Publish to Redis for SSE
        await publishEvent(crawlId, {
          type: "log",
          level,
          message,
          url,
          timestamp: new Date().toISOString(),
        });

        // Store in database
        await db.insert(crawlLogs).values({
          crawlId,
          level,
          message,
          url,
        });
      },
    });

    // Move output to permanent storage
    const finalPath = path.join(storagePath, "archives", crawlId);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.rename(outputDir, finalPath);

    // Calculate output size
    const outputSize = await getDirectorySize(finalPath);

    // Update crawl as completed
    await db
      .update(crawls)
      .set({
        status: "completed",
        completedAt: new Date(),
        outputPath: `archives/${crawlId}`,
        outputSizeBytes: outputSize,
        totalPages: result.total,
        succeededPages: result.succeeded,
        failedPages: result.failed,
      })
      .where(eq(crawls.id, crawlId));

    await publishEvent(crawlId, {
      type: "log",
      level: "info",
      message: `Crawl completed: ${result.succeeded}/${result.total} pages in ${(result.durationMs / 1000).toFixed(1)}s`,
      timestamp: new Date().toISOString(),
    });

    console.log(
      `[Worker] Crawl completed: ${crawlId} - ${result.succeeded}/${result.total} pages`
    );
  } catch (error) {
    console.error(`[Worker] Crawl failed: ${crawlId}`, error);

    await db
      .update(crawls)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: (error as Error).message,
      })
      .where(eq(crawls.id, crawlId));

    await publishEvent(crawlId, {
      type: "log",
      level: "error",
      message: `Crawl failed: ${(error as Error).message}`,
      timestamp: new Date().toISOString(),
    });

    // Clean up temp directory on failure
    try {
      await fs.rm(outputDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    throw error;
  }
}

async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  async function walk(dir: string) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
        } else {
          const stat = await fs.stat(entryPath);
          totalSize += stat.size;
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  await walk(dirPath);
  return totalSize;
}

export function startWorker() {
  const worker = new Worker<CrawlJobData>("crawl-jobs", processCrawlJob, {
    connection: workerConnection,
    concurrency: 2, // Process 2 crawls at a time
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  });

  worker.on("completed", (job) => {
    console.log(`[Worker] Job completed: ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[Worker] Job failed: ${job?.id}`, error.message);
  });

  worker.on("error", (error) => {
    console.error("[Worker] Worker error:", error);
  });

  console.log("[Worker] Started crawl job processor");

  return worker;
}
