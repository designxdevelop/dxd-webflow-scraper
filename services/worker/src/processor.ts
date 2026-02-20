import { Worker, Job, Queue, UnrecoverableError } from "bullmq";
import Redis from "ioredis";
import { eq, and, inArray, lte, desc, isNotNull } from "drizzle-orm";
import { crawlSite, type CrawlProgress, type LogLevel } from "@dxd/scraper";
import { getStorage } from "@dxd/storage";
import { db, sites, crawls, crawlLogs, settings } from "./db.js";
import fs from "node:fs/promises";
import nodeFs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { once } from "node:events";

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
  defaultJobOptions: {
    // Critical: Prevent BullMQ from auto-retrying failed jobs
    // We handle retries manually by preserving state and checking shouldResume
    attempts: 1,
    // Don't keep completed jobs around - we track state in DB
    removeOnComplete: { count: 10 },
    // Keep some failed jobs for debugging, but not too many
    removeOnFail: { count: 50 },
    // Disable backoff - we don't want automatic retries with delay
    backoff: { type: "fixed", delay: 0 },
  },
});

interface CrawlJobData {
  siteId: string;
  crawlId: string;
}

async function readGlobalDownloadBlacklist(): Promise<string[]> {
  const setting = await db.query.settings.findFirst({
    where: eq(settings.key, "globalDownloadBlacklist"),
  });

  const value = setting?.value;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
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

function getArchivePath(crawlId: string): string {
  return `archives/${crawlId}.zip`;
}

function getLegacyArchivePath(outputPath: string): string {
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

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    return operation;
  }

  return await Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
    }),
  ]);
}

async function publishEvent(crawlId: string, event: object) {
  const payload = JSON.stringify(event);
  await pubClient.publish(`crawl:${crawlId}`, payload);
  await pubClient.xadd(
    `crawl-events:${crawlId}`,
    "MAXLEN",
    "~",
    1000,
    "*",
    "data",
    payload
  );
}

async function getLocalDirectorySize(dirPath: string): Promise<number> {
  let total = 0;

  async function walk(currentPath: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true } as const);
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = `${currentPath}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(entryPath);
          return;
        }

        if (!entry.isFile()) {
          return;
        }

        try {
          const stat = await fs.stat(entryPath);
          total += stat.size;
        } catch {
          // Ignore files that vanish while scanning.
        }
      })
    );
  }

  await walk(dirPath);
  return total;
}

async function walkLocalFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  await walk(rootDir);
  return files;
}

function createFileReadableStream(
  filePath: string,
  chunkSize = 8 * 1024 * 1024
): ReadableStream<Uint8Array> {
  let fileHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let position = 0;

  const closeFileHandle = async (): Promise<void> => {
    const handle = fileHandle;
    fileHandle = null;
    if (!handle) {
      return;
    }
    try {
      await handle.close();
    } catch (error) {
      if (!isBadFileDescriptorError(error)) {
        throw error;
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    async start() {
      fileHandle = await fs.open(filePath, "r");
    },
    async pull(controller) {
      if (!fileHandle) {
        controller.error(new Error(`Archive stream handle is not available for ${filePath}`));
        return;
      }

      try {
        const buffer = Buffer.allocUnsafe(chunkSize);
        const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize, position);

        if (bytesRead <= 0) {
          await closeFileHandle();
          controller.close();
          return;
        }

        position += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) {
        await closeFileHandle().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      await closeFileHandle();
    },
  });
}

function isBadFileDescriptorError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "EBADF"
  );
}

async function uploadArchiveFromTempDir(
  crawlId: string,
  outputDir: string
): Promise<{ archivePath: string; outputSize: number }> {
  const archivePath = getArchivePath(crawlId);
  const sourceBytes = await getLocalDirectorySize(outputDir);

  if (sourceBytes <= 0) {
    const existingArchiveSize = await storage.getSize(archivePath);
    if (existingArchiveSize > 0) {
      return { archivePath, outputSize: existingArchiveSize };
    }
    throw new Error(`No crawl output found in temp (${outputDir}) and no existing archive at ${archivePath}`);
  }

  const files = await walkLocalFiles(outputDir);
  if (files.length === 0) {
    throw new Error(`No files found to archive in ${outputDir}`);
  }

  const localArchivePath = path.join(outputDir, "__archive__.zip");

  await publishEvent(crawlId, {
    type: "progress",
    phase: "uploading",
    upload: {
      totalBytes: sourceBytes,
      uploadedBytes: 0,
      filesTotal: 1,
      filesUploaded: 0,
      currentFile: "archive.zip",
      percent: 0,
    },
  });

  // Save initial upload progress to database for list view
  await db
    .update(crawls)
    .set({
      uploadTotalBytes: sourceBytes,
      uploadUploadedBytes: 0,
      uploadFilesTotal: 1,
      uploadFilesUploaded: 0,
      uploadCurrentFile: "archive.zip",
    })
    .where(eq(crawls.id, crawlId));

  const archive = archiver("zip", { zlib: { level: 9 } });
  const archiveOutput = nodeFs.createWriteStream(localArchivePath);
  archive.pipe(archiveOutput);
  archive.on("warning", (error: Error) => {
    console.warn("[Worker] Archive warning", {
      crawlId,
      outputDir,
      error: error.message,
    });
  });
  archive.on("error", (error: Error) => {
    console.error("[Worker] Archive error", {
      crawlId,
      outputDir,
      error: error.message,
    });
  });

  try {
    for (const file of files) {
      const relativePath = path.relative(outputDir, file).replace(/\\/g, "/");
      archive.file(file, { name: relativePath });
    }

    await archive.finalize();
    await once(archiveOutput, "close");

    const archiveSize = (await fs.stat(localArchivePath)).size;
    
    // Upload with progress tracking and throttling to prevent TCP_OVERWINDOW
    // Add 50ms delay between 16MB parts to smooth out network traffic
    const partDelayMs = 50;
    let lastDbUpdate = 0;
    const dbUpdateIntervalMs = 1000; // Update DB every second max
    
    const uploadOptions = {
      totalSize: archiveSize,
      partDelayMs,
      onProgress: async (progress: any) => {
        const percent = progress.totalBytes > 0 
          ? Math.round((progress.uploadedBytes / progress.totalBytes) * 100)
          : 0;
        
        // Publish real-time progress event
        await publishEvent(crawlId, {
          type: "progress",
          phase: "uploading",
          upload: {
            totalBytes: progress.totalBytes,
            uploadedBytes: progress.uploadedBytes,
            filesTotal: 1,
            filesUploaded: progress.partNumber > 0 ? 1 : 0,
            currentFile: `archive.zip (part ${progress.partNumber}/${progress.totalParts})`,
            percent,
          },
        });
        
        // Update DB throttled (max once per second)
        const now = Date.now();
        if (now - lastDbUpdate >= dbUpdateIntervalMs) {
          lastDbUpdate = now;
          await db
            .update(crawls)
            .set({
              uploadTotalBytes: progress.totalBytes,
              uploadUploadedBytes: progress.uploadedBytes,
              uploadFilesTotal: 1,
              uploadFilesUploaded: progress.partNumber > 0 ? 1 : 0,
              uploadCurrentFile: `archive.zip (part ${progress.partNumber}/${progress.totalParts})`,
            })
            .where(eq(crawls.id, crawlId));
        }
      },
    };

    if (storage.uploadFile) {
      await storage.uploadFile(archivePath, localArchivePath, uploadOptions);
    } else {
      const archiveReadStream = createFileReadableStream(localArchivePath);
      await storage.writeStream(archivePath, archiveReadStream, uploadOptions);
    }

    const outputSize = await storage.getSize(archivePath);
    
    // Final progress update (100%)
    await publishEvent(crawlId, {
      type: "progress",
      phase: "uploading",
      upload: {
        totalBytes: sourceBytes,
        uploadedBytes: sourceBytes,
        filesTotal: 1,
        filesUploaded: 1,
        currentFile: "archive.zip",
        percent: 100,
      },
    });

    // Save final upload progress to database
    await db
      .update(crawls)
      .set({
        uploadTotalBytes: sourceBytes,
        uploadUploadedBytes: sourceBytes,
        uploadFilesTotal: 1,
        uploadFilesUploaded: 1,
        uploadCurrentFile: "archive.zip",
      })
      .where(eq(crawls.id, crawlId));

    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    return { archivePath, outputSize };
  } catch (error) {
    await storage.deleteDir(archivePath).catch(() => undefined);
    archive.destroy(error as Error);
    throw error;
  } finally {
    await fs.rm(localArchivePath, { force: true }).catch(() => undefined);
  }
}

async function pruneOldArchives(siteId: string, keepCount: number, currentCrawlId: string): Promise<void> {
  if (!Number.isFinite(keepCount) || keepCount < 1) {
    return;
  }

  const archivedCrawls = await db.query.crawls.findMany({
    where: and(
      eq(crawls.siteId, siteId),
      inArray(crawls.status, ["completed", "timed_out"]),
      isNotNull(crawls.outputPath)
    ),
    orderBy: [desc(crawls.completedAt), desc(crawls.createdAt)],
  });

  const toDelete = archivedCrawls.slice(keepCount);
  if (toDelete.length === 0) {
    return;
  }

  for (const oldCrawl of toDelete) {
    const outputPath = oldCrawl.outputPath;
    if (!outputPath) {
      continue;
    }

    if (outputPath.endsWith(".zip")) {
      await storage.deleteDir(outputPath).catch(() => undefined);
    } else {
      await storage.deleteDir(outputPath).catch(() => undefined);
      await storage.deleteDir(getLegacyArchivePath(outputPath)).catch(() => undefined);
    }

    await db
      .update(crawls)
      .set({
        outputPath: null,
        outputSizeBytes: null,
      })
      .where(eq(crawls.id, oldCrawl.id));

    if (oldCrawl.id !== currentCrawlId) {
      await publishEvent(currentCrawlId, {
        type: "log",
        level: "info",
        message: `Pruned old archive from crawl ${oldCrawl.id}`,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

async function processCrawlJob(job: Job<CrawlJobData>) {
  const { siteId, crawlId } = job.data;

  const maxAttempts = Math.max(1, job.opts.attempts ?? 1);
  const currentAttempt = job.attemptsMade + 1;
  const isRetry = currentAttempt > 1;
  const previousFailedReason = job.failedReason;

  console.log(
    `[Worker] ${isRetry ? "RETRY" : "START"} crawl job: ${crawlId} (attempt ${currentAttempt}/${maxAttempts}) for site: ${siteId}${previousFailedReason ? ` | Previous error: ${previousFailedReason.substring(0, 200)}` : ""}`
  );

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

  const activeStatuses = new Set(["pending", "running", "uploading"]);
  if (!activeStatuses.has(crawl.status ?? "pending")) {
    console.log(`[Worker] Skipping crawl ${crawlId}; current status is ${crawl.status}`);
    return;
  }

  // Update status to running
  await db
    .update(crawls)
    .set({ status: "running", startedAt: crawl.startedAt ?? new Date(), errorMessage: null })
    .where(eq(crawls.id, crawlId));

  // Log detailed restart information
  if (isRetry) {
    const restartMessage = previousFailedReason
      ? `RETRY attempt ${currentAttempt}/${maxAttempts} after failure: ${previousFailedReason.substring(0, 300)}${previousFailedReason.length > 300 ? "..." : ""}`
      : `RETRY attempt ${currentAttempt}/${maxAttempts} (previous failure reason not available)`;

    await publishEvent(crawlId, {
      type: "log",
      level: "warn",
      message: restartMessage,
      timestamp: new Date().toISOString(),
    });

    // Also persist to crawl logs for audit trail
    await db.insert(crawlLogs).values({
      crawlId,
      level: "warn",
      message: restartMessage,
    });
  }

  await publishEvent(crawlId, {
    type: "log",
    level: "info",
    message: `Starting crawl of ${site.url}${isRetry ? ` (attempt ${currentAttempt}/${maxAttempts})` : ""}`,
    timestamp: new Date().toISOString(),
  });

  const maxDurationMs = parsePositiveIntEnv("CRAWL_MAX_DURATION_MS", 45 * 60 * 1000);
  const progressPersistIntervalMs = parsePositiveIntEnv("CRAWL_PROGRESS_PERSIST_INTERVAL_MS", 1500);
  const statusCheckIntervalMs = parsePositiveIntEnv("CRAWL_STATUS_CHECK_INTERVAL_MS", 3000);
  const maxSiteConcurrency = parsePositiveIntEnv("MAX_SITE_CONCURRENCY", 30);
  const archiveUploadTimeoutMs = parsePositiveIntEnv("ARCHIVE_UPLOAD_TIMEOUT_MS", 600000); // 10 minutes default for large archives
  const crawlConcurrency = Math.max(1, Math.min(site.concurrency ?? 5, maxSiteConcurrency));
  const globalDownloadBlacklist = await readGlobalDownloadBlacklist();
  const combinedDownloadBlacklist = Array.from(
    new Set([...(globalDownloadBlacklist ?? []), ...(site.downloadBlacklist ?? [])])
  );

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
  let crawlPhaseComplete = false;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
  }, maxDurationMs);

  const assertCrawlIsActive = async (force = false): Promise<void> => {
    if (!crawlPhaseComplete && timeoutController.signal.aborted) {
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

  // Create output directory — check if partial output exists for resume
  const outputDir = await storage.createTempDir(crawlId);
  let shouldResume = false;
  let resumeStats: { succeeded: number; failed: number } | null = null;

  const stateFile = `${outputDir}/.crawl-state.json`;
  try {
    if (await fs.access(stateFile).then(() => true).catch(() => false)) {
      const stateData = await fs.readFile(stateFile, "utf-8");
      const state = JSON.parse(stateData);
      if (state && Array.isArray(state.succeeded) && Array.isArray(state.failed)) {
        shouldResume = true;
        resumeStats = {
          succeeded: state.succeeded.length,
          failed: state.failed.length,
        };
        const resumeMsg = `Found existing crawl state: ${resumeStats.succeeded} succeeded, ${resumeStats.failed} failed URLs will be skipped`;
        console.log(`[Worker] ${resumeMsg} for crawl ${crawlId}`);
        await publishEvent(crawlId, {
          type: "log",
          level: "info",
          message: resumeMsg,
          timestamp: new Date().toISOString(),
        });
      } else {
        const invalidMsg = "Found state file but it has invalid format, starting fresh";
        console.warn(`[Worker] ${invalidMsg} for crawl ${crawlId}`);
        await publishEvent(crawlId, {
          type: "log",
          level: "warn",
          message: invalidMsg,
          timestamp: new Date().toISOString(),
        });
      }
    } else if (isRetry) {
      // We expected a state file since this is a retry, but it's missing
      const missingMsg = `Expected state file for retry but none found at ${stateFile}. Crawl will restart from beginning (previous temp dir may have been cleaned up).`;
      console.warn(`[Worker] ${missingMsg} for crawl ${crawlId}`);
      await publishEvent(crawlId, {
        type: "log",
        level: "error",
        message: missingMsg,
        timestamp: new Date().toISOString(),
      });
      await db.insert(crawlLogs).values({
        crawlId,
        level: "error",
        message: missingMsg,
      });
    } else {
      // Fresh crawl start - no state file and not a retry
      const freshStartMsg = `Starting fresh crawl - no previous state found at ${stateFile}`;
      console.log(`[Worker] ${freshStartMsg} for crawl ${crawlId}`);
      await publishEvent(crawlId, {
        type: "log",
        level: "info",
        message: freshStartMsg,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    const readErrorMsg = `Failed to read state file: ${(error as Error).message}. Starting fresh.`;
    console.error(`[Worker] ${readErrorMsg} for crawl ${crawlId}`);
    await publishEvent(crawlId, {
      type: "log",
      level: "error",
      message: readErrorMsg,
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const result = await crawlSite({
      baseUrl: site.url,
      outputDir,
      concurrency: crawlConcurrency,
      maxPages: site.maxPages ?? undefined,
      excludePatterns: site.excludePatterns ?? undefined,
      downloadBlacklist: combinedDownloadBlacklist,
      removeWebflowBadge: site.removeWebflowBadge ?? true,
      redirectsCsv: site.redirectsCsv ?? undefined,
      resume: shouldResume,
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
    crawlPhaseComplete = true;
    clearTimeout(timeoutId);

    await assertCrawlIsActive(true);

    await db
      .update(crawls)
      .set({ status: "uploading" })
      .where(eq(crawls.id, crawlId));

    const timeoutMinutes = Math.round(archiveUploadTimeoutMs / 60000);
    const outputSizeBytes = await getLocalDirectorySize(outputDir);
    const sizeMB = (outputSizeBytes / 1024 / 1024).toFixed(1);
    await publishEvent(crawlId, {
      type: "log",
      level: "info",
      message: `Compressing and uploading ${sizeMB}MB ZIP archive (timeout: ${timeoutMinutes}min)`,
      timestamp: new Date().toISOString(),
    });

    await assertCrawlIsActive();
    const { archivePath, outputSize } = await withTimeout(
      uploadArchiveFromTempDir(crawlId, outputDir),
      archiveUploadTimeoutMs,
      `Archive upload for crawl ${crawlId}`
    );

    await assertCrawlIsActive(true);

    await db
      .update(crawls)
      .set({
        status: "completed",
        completedAt: new Date(),
        outputPath: archivePath,
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

    await publishEvent(crawlId, {
      type: "log",
      level: "info",
      message: "ZIP archive uploaded and ready for download",
      timestamp: new Date().toISOString(),
    });

    await pruneOldArchives(siteId, site.maxArchivesToKeep ?? Number.POSITIVE_INFINITY, crawlId);

    console.log(
      `[Worker] Crawl completed: ${crawlId} - ${result.succeeded}/${result.total} pages`
    );
  } catch (error) {
    console.error(`[Worker] Crawl failed: ${crawlId}`, error);

    const isCancelled = error instanceof CrawlCancelledError;
    const isTimeout = error instanceof CrawlTimeoutError;
    const errorMessage = (error as Error).message;

    // On timeout, save partial progress instead of deleting everything
    if (isTimeout) {
      console.log(`[Worker] Crawl timed out, saving partial results: ${crawlId}`);

      try {
        await db
          .update(crawls)
          .set({ status: "uploading" })
          .where(eq(crawls.id, crawlId));

        await publishEvent(crawlId, {
          type: "log",
          level: "warn",
          message: `Crawl timed out after ${Math.round(maxDurationMs / 60000)} minutes. Saving partial results...`,
          timestamp: new Date().toISOString(),
        });

        const { archivePath, outputSize } = await withTimeout(
          uploadArchiveFromTempDir(crawlId, outputDir),
          archiveUploadTimeoutMs,
          `Archive upload for timed out crawl ${crawlId}`
        );

        await db
          .update(crawls)
          .set({
            status: "timed_out",
            completedAt: new Date(),
            outputPath: archivePath,
            outputSizeBytes: outputSize,
            errorMessage,
          })
          .where(eq(crawls.id, crawlId));

        await pruneOldArchives(siteId, site.maxArchivesToKeep ?? Number.POSITIVE_INFINITY, crawlId);

        await publishEvent(crawlId, {
          type: "log",
          level: "warn",
          message: `Partial results saved (timed out).`,
          timestamp: new Date().toISOString(),
        });

        return; // Don't re-throw — partial success
      } catch (uploadError) {
        console.error(`[Worker] Failed to save partial results: ${crawlId}`, uploadError);
        // Fall through to normal failure handling
      }
    }

    const status = isCancelled ? "cancelled" : "failed";

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

    if (isCancelled) {
      try {
        await fs.rm(outputDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      return;
    }

    const hasMoreRetries = currentAttempt < maxAttempts;
    if (hasMoreRetries) {
      await publishEvent(crawlId, {
        type: "log",
        level: "warn",
        message: `Preserving partial crawl output for retry ${currentAttempt + 1}/${maxAttempts}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      try {
        await fs.rm(outputDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
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

  console.log(`[Worker] Orphan check: Found ${possiblyOrphaned.length} crawls older than ${orphanGraceMs}ms in active states`);

  for (const crawl of possiblyOrphaned) {
    const queueJob = await crawlQueue.getJob(crawl.id);
    const ageMinutes = crawl.createdAt
      ? Math.round((Date.now() - crawl.createdAt.getTime()) / 60000)
      : 0;

    if (!queueJob) {
      // Re-enqueue any active crawl (pending, running, uploading) that's missing its queue job
      // This allows crawls to resume from saved state instead of being marked as failed
      const activeStatuses = new Set(["pending", "running", "uploading"]);
      if (crawl.status && activeStatuses.has(crawl.status) && crawl.siteId) {
        try {
          // Check if state file exists to report progress that will be resumed
          const tempDir = await storage.createTempDir(crawl.id);
          const stateFile = `${tempDir}/.crawl-state.json`;
          let stateInfo = "";
          try {
            const stateData = await fs.readFile(stateFile, "utf-8");
            const state = JSON.parse(stateData);
            if (state && Array.isArray(state.succeeded) && Array.isArray(state.failed)) {
              const totalProgress = state.succeeded.length + state.failed.length;
              stateInfo = ` (${state.succeeded.length} succeeded, ${state.failed.length} failed = ${totalProgress} total URLs will be skipped)`;
            }
          } catch {
            // State file doesn't exist or is invalid - crawl will start fresh
            stateInfo = " (no state file found - crawl will restart from beginning)";
          }

          await crawlQueue.add(
            "crawl",
            {
              siteId: crawl.siteId,
              crawlId: crawl.id,
            },
            {
              jobId: crawl.id,
              // Ensure no retries - orphan requeue should be a fresh attempt
              attempts: 1,
            }
          );
          const requeueMsg = `RE-ENQUEUED orphaned ${crawl.status} crawl (age: ${ageMinutes}min, reason: worker crash/restart)${stateInfo}`;
          console.warn(`[Worker] ${requeueMsg}: ${crawl.id}`);
          // Publish event so UI shows this happened
          await publishEvent(crawl.id, {
            type: "log",
            level: "warn",
            message: `Orphan reconciliation: ${requeueMsg}`,
            timestamp: new Date().toISOString(),
          });
          await db.insert(crawlLogs).values({
            crawlId: crawl.id,
            level: "warn",
            message: `Orphan reconciliation: ${requeueMsg}`,
          });
          continue;
        } catch (error) {
          console.error(`[Worker] Failed to re-enqueue orphaned crawl ${crawl.id}`, error);
        }
      }

      const failMsg = `Crawl marked failed automatically: no queue job found for ${crawl.status} crawl (age: ${ageMinutes}min)`;
      console.warn(`[Worker] ${failMsg}: ${crawl.id}`);
      await publishEvent(crawl.id, {
        type: "log",
        level: "error",
        message: `Orphan reconciliation: ${failMsg}`,
        timestamp: new Date().toISOString(),
      });
      await db.insert(crawlLogs).values({
        crawlId: crawl.id,
        level: "error",
        message: `Orphan reconciliation: ${failMsg}`,
      });

      await db
        .update(crawls)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage: failMsg,
        })
        .where(eq(crawls.id, crawl.id));
      continue;
    }

    const state = await queueJob.getState();
    if (
      state === "active" ||
      state === "waiting" ||
      state === "delayed" ||
      state === "prioritized" ||
      state === "waiting-children"
    ) {
      // Job is in a valid queue state, not an orphan
      continue;
    }

    // Job exists but is in a terminal state (completed, failed, etc.)
    const terminalMsg = `Crawl marked failed automatically: queue job in terminal state "${state}" (age: ${ageMinutes}min)`;
    console.warn(`[Worker] ${terminalMsg}: ${crawl.id}`);
    await publishEvent(crawl.id, {
      type: "log",
      level: "error",
      message: `Orphan reconciliation: ${terminalMsg}`,
      timestamp: new Date().toISOString(),
    });
    await db.insert(crawlLogs).values({
      crawlId: crawl.id,
      level: "error",
      message: `Orphan reconciliation: ${terminalMsg}`,
    });

    await db
      .update(crawls)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: terminalMsg,
      })
      .where(eq(crawls.id, crawl.id));
  }
}

export function startWorker() {
  const workerConcurrency = parsePositiveIntEnv("WORKER_CRAWL_CONCURRENCY", 2);
  // Long crawl/upload/zip phases can starve lock renewal under heavy CPU pressure.
  // Use conservative defaults to avoid duplicate retry attempts on healthy long-running jobs.
  const lockDuration = parsePositiveIntEnv("WORKER_LOCK_DURATION_MS", 900000);
  const stalledInterval = parsePositiveIntEnv("WORKER_STALLED_INTERVAL_MS", 120000);
  const maxStalledCount = parsePositiveIntEnv("WORKER_MAX_STALLED_COUNT", 1);

  const worker = new Worker<CrawlJobData>("crawl-jobs", processCrawlJob, {
    connection: workerConnection,
    concurrency: workerConcurrency,
    lockDuration,
    stalledInterval,
    // Critical: Set to 0 to prevent BullMQ from auto-retrying stalled jobs
    // Stalled jobs are handled by orphan reconciliation - we want manual control
    maxStalledCount: 0,
    // Disable automatic job recovery - we'll handle it via reconcileOrphanedCrawls
    skipLockRenewal: true,
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
    console.log(`[Worker] BullMQ job completed: ${completedJob.id} (attempt ${completedJob.attemptsMade + 1}/${completedJob.opts.attempts ?? 1})`);
  });

  worker.on("failed", (failedJob, error) => {
    if (!failedJob) {
      console.error("[Worker] Job failed (no job data):", error.message);
      return;
    }
    const attempts = failedJob.attemptsMade + 1;
    const maxAttempts = failedJob.opts.attempts ?? 1;
    const willRetry = attempts < maxAttempts;
    console.error(
      `[Worker] BullMQ job failed: ${failedJob.id} (attempt ${attempts}/${maxAttempts})${willRetry ? " - Will retry" : " - Final attempt"}`,
      error.message
    );
  });

  worker.on("stalled", (jobId) => {
    console.warn(`[Worker] BullMQ job stalled: ${jobId} - Will be handled by orphan reconciliation`);
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
