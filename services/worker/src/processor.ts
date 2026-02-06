import { Worker, Job, Queue, UnrecoverableError } from "bullmq";
import Redis from "ioredis";
import { eq, and, inArray, lte } from "drizzle-orm";
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

// Redis connection for worker + queue inspection
const workerConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

const crawlQueue = new Queue<CrawlJobData>("crawl-jobs", {
  connection: workerConnection,
});

interface CrawlJobData {
  siteId: string;
  crawlId: string;
}

class CrawlCancelledError extends Error {
  constructor(message = "Crawl cancelled by user") {
    super(message);
    this.name = "CrawlCancelledError";
  }
}

class CrawlTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrawlTimeoutError";
  }
}

function getArchivePath(outputPath: string): string {
  return `${outputPath}.zip`;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

async function createPrebuiltArchive(crawlId: string, outputPath: string): Promise<string> {
  const archivePath = getArchivePath(outputPath);
  const outputPrefix = `${outputPath}/`;
  const files = (await storage.listFiles(outputPath)).filter((file) => file.startsWith(outputPrefix));

  if (files.length === 0) {
    throw new Error(`No files found to archive for crawl ${crawlId}`);
  }

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("warning", (error: Error) => {
    console.warn("[Worker] Archive warning", {
      crawlId,
      outputPath,
      error: error.message,
    });
  });

  archive.on("error", (error: Error) => {
    console.error("[Worker] Archive error", {
      crawlId,
      outputPath,
      error: error.message,
    });
  });

  const archiveStream = Readable.toWeb(archive) as ReadableStream<Uint8Array>;
  let writeError: unknown;
  const writePromise = storage.writeStream(archivePath, archiveStream).catch((error) => {
    writeError = error;
  });

  try {
    for (const file of files) {
      const relativePath = file.slice(outputPrefix.length);
      const fileStream = storage.readStream(file);
      archive.append(Readable.fromWeb(fileStream), { name: relativePath });
    }

    await archive.finalize();
    await writePromise;
    if (writeError) {
      throw writeError;
    }
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

  const site = await db.query.sites.findFirst({
    where: eq(sites.id, siteId),
  });

  if (!site) {
    throw new UnrecoverableError(`Site not found: ${siteId}`);
  }

  const crawl = await db.query.crawls.findFirst({
    where: eq(crawls.id, crawlId),
  });

  if (!crawl) {
    throw new UnrecoverableError(`Crawl not found: ${crawlId}`);
  }

  if (crawl.status === "cancelled") {
    console.log(`[Worker] Skipping cancelled crawl ${crawlId}`);
    return;
  }

  // Update status to running
  await db
    .update(crawls)
    .set({ status: "running", startedAt: crawl.startedAt ?? new Date(), errorMessage: null })
    .where(eq(crawls.id, crawlId));

  await publishEvent(crawlId, {
    type: "log",
    level: "info",
    message: `Starting crawl of ${site.url}`,
    timestamp: new Date().toISOString(),
  });

  const maxDurationMs = parsePositiveIntEnv("CRAWL_MAX_DURATION_MS", 45 * 60 * 1000);
  const progressPersistIntervalMs = parsePositiveIntEnv("CRAWL_PROGRESS_PERSIST_INTERVAL_MS", 1500);
  const statusCheckIntervalMs = parsePositiveIntEnv("CRAWL_STATUS_CHECK_INTERVAL_MS", 3000);
  const maxSiteConcurrency = parsePositiveIntEnv("MAX_SITE_CONCURRENCY", 8);
  const crawlConcurrency = Math.max(1, Math.min(site.concurrency ?? 5, maxSiteConcurrency));

  if ((site.concurrency ?? 5) > crawlConcurrency) {
    await publishEvent(crawlId, {
      type: "log",
      level: "warn",
      message: `Site concurrency capped at ${crawlConcurrency} for worker stability`,
      timestamp: new Date().toISOString(),
    });
  }

  let lastProgressPersistAt = 0;
  let lastStatusCheckAt = 0;
  let cancelled = false;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
  }, maxDurationMs);

  const assertCrawlIsActive = async (force = false): Promise<void> => {
    if (timeoutController.signal.aborted) {
      throw new CrawlTimeoutError(
        `Crawl exceeded max duration of ${Math.round(maxDurationMs / 60000)} minutes`
      );
    }

    if (cancelled) {
      throw new CrawlCancelledError();
    }

    const now = Date.now();
    if (!force && now - lastStatusCheckAt < statusCheckIntervalMs) {
      return;
    }

    lastStatusCheckAt = now;
    const latest = await db.query.crawls.findFirst({
      where: eq(crawls.id, crawlId),
    });

    if (!latest) {
      throw new CrawlCancelledError("Crawl record deleted while processing");
    }

    if (latest.status === "cancelled") {
      cancelled = true;
      throw new CrawlCancelledError();
    }
  };

  // Create output directory
  const outputDir = await storage.createTempDir(crawlId);

  try {
    const result = await crawlSite({
      baseUrl: site.url,
      outputDir,
      concurrency: crawlConcurrency,
      maxPages: site.maxPages ?? undefined,
      excludePatterns: site.excludePatterns ?? undefined,
      removeWebflowBadge: site.removeWebflowBadge ?? true,
      redirectsCsv: site.redirectsCsv ?? undefined,
      shouldAbort: async () => {
        try {
          await assertCrawlIsActive();
          return false;
        } catch (error) {
          if (error instanceof CrawlCancelledError || error instanceof CrawlTimeoutError) {
            return true;
          }
          throw error;
        }
      },

      onProgress: async (progress: CrawlProgress) => {
        await publishEvent(crawlId, {
          type: "progress",
          ...progress,
        });

        const now = Date.now();
        const isFinalProgress = !progress.currentUrl;
        if (isFinalProgress || now - lastProgressPersistAt >= progressPersistIntervalMs) {
          lastProgressPersistAt = now;
          await db
            .update(crawls)
            .set({
              totalPages: progress.total,
              succeededPages: progress.succeeded,
              failedPages: progress.failed,
            })
            .where(eq(crawls.id, crawlId));
        }

        await assertCrawlIsActive();
      },

      onLog: async (level: LogLevel, message: string, url?: string) => {
        // Ignore debug logs to avoid DB write amplification on large crawls.
        if (level === "debug") {
          return;
        }

        await publishEvent(crawlId, {
          type: "log",
          level,
          message,
          url,
          timestamp: new Date().toISOString(),
        });

        await db.insert(crawlLogs).values({
          crawlId,
          level,
          message,
          url,
        });
      },
    });

    await assertCrawlIsActive(true);

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

    await assertCrawlIsActive();
    const finalPath = await storage.moveToFinal(outputDir, crawlId);

    await assertCrawlIsActive();
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

    await assertCrawlIsActive(true);

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
        errorMessage: null,
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

    const isCancelled = error instanceof CrawlCancelledError;
    const status = isCancelled ? "cancelled" : "failed";
    const errorMessage = (error as Error).message;

    await db
      .update(crawls)
      .set({
        status,
        completedAt: new Date(),
        errorMessage,
      })
      .where(eq(crawls.id, crawlId));

    await publishEvent(crawlId, {
      type: "log",
      level: isCancelled ? "warn" : "error",
      message: isCancelled ? `Crawl cancelled: ${errorMessage}` : `Crawl failed: ${errorMessage}`,
      timestamp: new Date().toISOString(),
    });

    try {
      await fs.rm(outputDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    if (isCancelled) {
      return;
    }

    if (error instanceof CrawlTimeoutError) {
      throw new UnrecoverableError(error.message);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function reconcileOrphanedCrawls(): Promise<void> {
  const orphanGraceMs = parsePositiveIntEnv("ORPHAN_CRAWL_GRACE_MS", 5 * 60 * 1000);
  const cutoff = new Date(Date.now() - orphanGraceMs);

  const possiblyOrphaned = await db.query.crawls.findMany({
    where: and(
      inArray(crawls.status, ["pending", "running", "uploading"]),
      lte(crawls.createdAt, cutoff)
    ),
    limit: 50,
  });

  if (possiblyOrphaned.length === 0) {
    return;
  }

  for (const crawl of possiblyOrphaned) {
    const queueJob = await crawlQueue.getJob(crawl.id);
    if (!queueJob) {
      await db
        .update(crawls)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage:
            "Crawl marked failed automatically: no queue job found for pending/running crawl.",
        })
        .where(eq(crawls.id, crawl.id));
      continue;
    }

    const state = await queueJob.getState();
    if (state === "active" || state === "waiting" || state === "delayed" || state === "prioritized") {
      continue;
    }

    await db
      .update(crawls)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: `Crawl marked failed automatically: queue job state was ${state}.`,
      })
      .where(eq(crawls.id, crawl.id));
  }
}

export function startWorker() {
  const workerConcurrency = parsePositiveIntEnv("WORKER_CRAWL_CONCURRENCY", 2);
  const lockDuration = parsePositiveIntEnv("WORKER_LOCK_DURATION_MS", 120000);
  const stalledInterval = parsePositiveIntEnv("WORKER_STALLED_INTERVAL_MS", 60000);
  const maxStalledCount = parsePositiveIntEnv("WORKER_MAX_STALLED_COUNT", 1);

  const worker = new Worker<CrawlJobData>("crawl-jobs", processCrawlJob, {
    connection: workerConnection,
    concurrency: workerConcurrency,
    lockDuration,
    stalledInterval,
    maxStalledCount,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  });

  const reconcileIntervalMs = parsePositiveIntEnv("ORPHAN_CRAWL_RECONCILE_INTERVAL_MS", 120000);
  void reconcileOrphanedCrawls().catch((error) => {
    console.error("[Worker] Failed to reconcile orphaned crawls:", error);
  });

  const reconcileTimer = setInterval(() => {
    void reconcileOrphanedCrawls().catch((error) => {
      console.error("[Worker] Failed to reconcile orphaned crawls:", error);
    });
  }, reconcileIntervalMs);
  reconcileTimer.unref();

  worker.on("completed", (completedJob) => {
    console.log(`[Worker] Job completed: ${completedJob.id}`);
  });

  worker.on("failed", (failedJob, error) => {
    console.error(`[Worker] Job failed: ${failedJob?.id}`, error.message);
  });

  worker.on("error", (error) => {
    console.error("[Worker] Worker error:", error);
  });

  worker.on("closed", () => {
    clearInterval(reconcileTimer);
  });

  console.log(
    `[Worker] Started crawl job processor (concurrency=${workerConcurrency}, lockDuration=${lockDuration}ms)`
  );

  return worker;
}
