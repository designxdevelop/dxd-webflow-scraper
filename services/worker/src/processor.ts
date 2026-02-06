import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { eq } from "drizzle-orm";
import { crawlSite, type CrawlProgress, type LogLevel } from "@dxd/scraper";
import { getStorage } from "@dxd/storage";
import { db, sites, crawls, crawlLogs } from "./db.js";
import fs from "node:fs/promises";
import archiver from "archiver";
import { Readable } from "node:stream";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const storage = getStorage();

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

function getArchivePath(outputPath: string): string {
  return `${outputPath}.zip`;
}

async function createPrebuiltArchive(crawlId: string, outputPath: string): Promise<string> {
  const archivePath = getArchivePath(outputPath);
  const outputPrefix = `${outputPath}/`;
  const files = (await storage.listFiles(outputPath)).filter((file) => file.startsWith(outputPrefix));

  if (files.length === 0) {
    throw new Error(`No files found to archive for crawl ${crawlId}`);
  }

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("warning", (error) => {
    console.warn("[Worker] Archive warning", {
      crawlId,
      outputPath,
      error: error.message,
    });
  });

  archive.on("error", (error) => {
    console.error("[Worker] Archive error", {
      crawlId,
      outputPath,
      error: error.message,
    });
  });

  const archiveStream = Readable.toWeb(archive) as ReadableStream<Uint8Array>;
  const writePromise = storage.writeStream(archivePath, archiveStream);

  try {
    for (const file of files) {
      const relativePath = file.slice(outputPrefix.length);
      const fileStream = storage.readStream(file);
      archive.append(Readable.fromWeb(fileStream), { name: relativePath });
    }

    await archive.finalize();
    await writePromise;
    return archivePath;
  } catch (error) {
    await storage.deleteDir(archivePath).catch(() => undefined);
    archive.destroy(error as Error);
    throw error;
  }
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
  const outputDir = await storage.createTempDir(crawlId);

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

    await db
      .update(crawls)
      .set({ status: "uploading" })
      .where(eq(crawls.id, crawlId));

    await publishEvent(crawlId, {
      type: "log",
      level: "info",
      message: "Uploading output to storage",
      timestamp: new Date().toISOString(),
    });

    // Move output to permanent storage
    const finalPath = await storage.moveToFinal(outputDir, crawlId);

    // Calculate output size
    const outputSize = await storage.getSize(finalPath);

    await publishEvent(crawlId, {
      type: "log",
      level: "info",
      message: "Building ZIP archive for instant download",
      timestamp: new Date().toISOString(),
    });

    try {
      await createPrebuiltArchive(crawlId, finalPath);
    } catch (error) {
      console.error(`[Worker] Failed to prebuild archive: ${crawlId}`, error);
      await publishEvent(crawlId, {
        type: "log",
        level: "warn",
        message: `ZIP prebuild failed: ${(error as Error).message}. Download will fall back to on-demand ZIP generation.`,
        timestamp: new Date().toISOString(),
      });
    }

    // Update crawl as completed
    await db
      .update(crawls)
      .set({
        status: "completed",
        completedAt: new Date(),
        outputPath: finalPath,
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
