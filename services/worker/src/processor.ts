import { Worker, Job, Queue, UnrecoverableError } from "bullmq";
import Redis from "ioredis";
import { eq, and, inArray, lte, desc, isNotNull, notInArray } from "drizzle-orm";
import {
  crawlSite,
  CrawlCancelledError,
  CrawlTimeoutError,
  type CrawlProgress,
  type LogLevel,
  type CrawlResult,
} from "@dxd/scraper";
import { getStorage } from "@dxd/storage";
import type { MultipartUploadProgress } from "@dxd/storage/adapter";
import { db, sites, crawls, crawlLogs, settings } from "./db.js";
import fs from "node:fs/promises";
import nodeFs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { once } from "node:events";
import { captureMemorySnapshot, formatMemorySnapshot, type MemorySnapshot } from "./memory.js";

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

const archiveQueue = new Queue<ArchiveJobData>("archive-jobs", {
  connection: workerConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
    backoff: { type: "fixed", delay: 0 },
  },
});

interface CrawlJobData {
  siteId: string;
  crawlId: string;
}

interface ArchiveJobData {
  siteId: string;
  crawlId: string;
  finalStatus: "completed" | "timed_out";
  errorMessage?: string | null;
  crawlResult?: Pick<CrawlResult, "total" | "succeeded" | "failed" | "durationMs">;
}

function createExclusiveRunner() {
  let tail = Promise.resolve();

  return async function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await task();
    } finally {
      release();
      tryForceGC();
    }
  };
}

function tryForceGC(): void {
  try {
    if (typeof globalThis.Bun !== "undefined" && typeof (globalThis.Bun as any).gc === "function") {
      (globalThis.Bun as any).gc(true);
    } else if (typeof globalThis.gc === "function") {
      (globalThis.gc as () => void)();
    }
  } catch {
    // GC not available
  }
}

const runExclusiveWorkerJob = createExclusiveRunner();

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

function parseArchiveZlibLevel(): number {
  const raw = process.env.ARCHIVE_ZLIB_LEVEL;
  if (!raw) {
    return 1;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.max(0, Math.min(9, parsed));
}

type WorkerMemoryLogger = {
  snapshot: (
    label: string,
    extra?: Record<string, string | number | boolean | null | undefined>
  ) => Promise<MemorySnapshot>;
  getPeakRssBytes: () => number;
};

function createWorkerMemoryLogger(
  crawlId: string,
  publish: (level: LogLevel, message: string) => Promise<void>
): WorkerMemoryLogger {
  let peakRssBytes = 0;

  return {
    async snapshot(label, extra) {
      const snapshot = captureMemorySnapshot();
      peakRssBytes = Math.max(peakRssBytes, snapshot.rssBytes);
      await publish("info", formatMemorySnapshot(label, snapshot, peakRssBytes, extra));
      return snapshot;
    },
    getPeakRssBytes() {
      return peakRssBytes;
    },
  };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    return operation;
  }

  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
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
  outputDir: string,
  options?: {
    zlibLevel?: number;
    onAfterArchive?: (archiveSize: number, sourceBytes: number) => Promise<void>;
    onAfterUpload?: (outputSize: number) => Promise<void>;
    assertNotCancelled?: () => Promise<void>;
  }
): Promise<{ archivePath: string; outputSize: number }> {
  const archivePath = getArchivePath(crawlId);
  await options?.assertNotCancelled?.();
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

  await options?.assertNotCancelled?.();

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

  const archive = archiver("zip", { zlib: { level: options?.zlibLevel ?? 1 } });
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
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      if (i % 50 === 0) {
        await options?.assertNotCancelled?.();
      }
      const relativePath = path.relative(outputDir, file).replace(/\\/g, "/");
      archive.file(file, { name: relativePath });
    }

    await options?.assertNotCancelled?.();
    await archive.finalize();
    await once(archiveOutput, "close");

    const archiveSize = (await fs.stat(localArchivePath)).size;
    await options?.assertNotCancelled?.();
    await options?.onAfterArchive?.(archiveSize, sourceBytes);
    
    // Upload with progress tracking and throttling to prevent TCP_OVERWINDOW
    // Add 50ms delay between 16MB parts to smooth out network traffic
    const partDelayMs = 50;
    let lastDbUpdate = 0;
    const dbUpdateIntervalMs = 1000; // Update DB every second max
    
    const uploadOptions = {
      totalSize: archiveSize,
      partDelayMs,
      onProgress: async (progress: MultipartUploadProgress) => {
        await options?.assertNotCancelled?.();
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

    await options?.assertNotCancelled?.();
    if (storage.uploadFile) {
      await storage.uploadFile(archivePath, localArchivePath, uploadOptions);
    } else {
      const archiveReadStream = createFileReadableStream(localArchivePath);
      await storage.writeStream(archivePath, archiveReadStream, uploadOptions);
    }

    await options?.assertNotCancelled?.();
    const outputSize = await storage.getSize(archivePath);
    await options?.assertNotCancelled?.();
    await options?.onAfterUpload?.(outputSize);
    
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
    archive.removeAllListeners();
    archive.destroy();
    return { archivePath, outputSize };
  } catch (error) {
    await storage.deleteDir(archivePath).catch(() => undefined);
    archive.removeAllListeners();
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

function isCrawlQueueStatus(status: string | null | undefined): boolean {
  return status === "pending" || status === "running";
}

function isArchiveQueueStatus(status: string | null | undefined): boolean {
  return status === "archiving" || status === "uploading";
}

async function publishLogAndPersist(crawlId: string, level: LogLevel, message: string): Promise<void> {
  await publishEvent(crawlId, {
    type: "log",
    level,
    message,
    timestamp: new Date().toISOString(),
  });

  await db.insert(crawlLogs).values({
    crawlId,
    level,
    message,
  });
}

async function enqueueArchiveJob(data: ArchiveJobData): Promise<void> {
  await archiveQueue.add("archive", data, {
    jobId: data.crawlId,
    attempts: 1,
  });
}

async function resolveArchiveResult(job: ArchiveJobData) {
  const crawl = await db.query.crawls.findFirst({ where: eq(crawls.id, job.crawlId) });
  if (!crawl) {
    throw new UnrecoverableError(`Crawl not found: ${job.crawlId}`);
  }

  const site = await db.query.sites.findFirst({ where: eq(sites.id, job.siteId) });
  if (!site) {
    throw new UnrecoverableError(`Site not found: ${job.siteId}`);
  }

  return { crawl, site };
}

async function processArchiveJob(job: Job<ArchiveJobData>) {
  return runExclusiveWorkerJob(async () => {
    const { crawlId, siteId, finalStatus, errorMessage, crawlResult } = job.data;
    const { crawl, site } = await resolveArchiveResult(job.data);

    if (!isArchiveQueueStatus(crawl.status)) {
      console.log(`[Worker] Skipping archive job ${crawlId}; current status is ${crawl.status}`);
      return;
    }

    const assertArchiveCancellable = async (): Promise<void> => {
      const latest = await db.query.crawls.findFirst({ where: eq(crawls.id, crawlId) });
      if (!latest) {
        throw new CrawlCancelledError("Crawl record deleted while archiving");
      }
      if (latest.status === "cancelled" || latest.status === "failed") {
        throw new CrawlCancelledError(`Archive stopped: crawl status is ${latest.status}`);
      }
    };

    const zlibLevel = parseArchiveZlibLevel();
    const archiveUploadTimeoutMs = parsePositiveIntEnv("ARCHIVE_UPLOAD_TIMEOUT_MS", 600000);
    const outputDir = await storage.createTempDir(crawlId);
    const memoryLogger = createWorkerMemoryLogger(crawlId, (level, message) => publishLogAndPersist(crawlId, level, message));

    await memoryLogger.snapshot("before archive", { finalStatus, zlibLevel });
    await db
      .update(crawls)
      .set({ status: "archiving" })
      .where(and(eq(crawls.id, crawlId), notInArray(crawls.status, ["cancelled", "failed"])));

    const outputSizeBytes = await getLocalDirectorySize(outputDir);
    const sizeMB = (outputSizeBytes / 1024 / 1024).toFixed(1);
    await publishLogAndPersist(
      crawlId,
      "info",
      `Creating ZIP archive (${sizeMB}MB source, zlib level ${zlibLevel}, timeout ${Math.round(archiveUploadTimeoutMs / 60000)}min)`
    );

    let archivePath: string;
    let outputSize: number;

    try {
      const uploaded = await withTimeout(
        uploadArchiveFromTempDir(crawlId, outputDir, {
          zlibLevel,
          assertNotCancelled: assertArchiveCancellable,
          onAfterArchive: async (archiveSize, sourceBytes) => {
            await assertArchiveCancellable();
            await memoryLogger.snapshot("after archive", { archiveSizeBytes: archiveSize, sourceBytes });
            await db
              .update(crawls)
              .set({ status: "uploading" })
              .where(and(eq(crawls.id, crawlId), notInArray(crawls.status, ["cancelled", "failed"])));
          },
          onAfterUpload: async (uploadedSize) => {
            await assertArchiveCancellable();
            await memoryLogger.snapshot("after upload", { uploadedSizeBytes: uploadedSize });
          },
        }),
        archiveUploadTimeoutMs,
        `Archive upload for crawl ${crawlId}`
      );
      archivePath = uploaded.archivePath;
      outputSize = uploaded.outputSize;
    } catch (error) {
      if (error instanceof CrawlCancelledError) {
        await publishLogAndPersist(crawlId, "warn", `Archive aborted: ${error.message}`);
        return;
      }
      throw error;
    }

    const totalPages = crawlResult?.total ?? crawl.totalPages ?? 0;
    const succeededPages = crawlResult?.succeeded ?? crawl.succeededPages ?? 0;
    const failedPages = crawlResult?.failed ?? crawl.failedPages ?? 0;

    const updatedRows = await db
      .update(crawls)
      .set({
        status: finalStatus,
        completedAt: new Date(),
        outputPath: archivePath,
        outputSizeBytes: outputSize,
        totalPages,
        succeededPages,
        failedPages,
        errorMessage: finalStatus === "timed_out" ? errorMessage ?? crawl.errorMessage : null,
      })
      .where(and(eq(crawls.id, crawlId), notInArray(crawls.status, ["cancelled", "failed"])))
      .returning({ id: crawls.id });

    if (updatedRows.length === 0) {
      await publishLogAndPersist(
        crawlId,
        "warn",
        "Skipped marking crawl completed: status is cancelled or failed (user may have cancelled during upload)"
      );
      return;
    }

    if (finalStatus === "completed") {
      await publishLogAndPersist(
        crawlId,
        "info",
        `Crawl completed: ${succeededPages}/${totalPages} pages in ${((crawlResult?.durationMs ?? 0) / 1000).toFixed(1)}s`
      );
      await publishLogAndPersist(crawlId, "info", "ZIP archive uploaded and ready for download");
    } else {
      await publishLogAndPersist(crawlId, "warn", "Partial results saved after timeout");
    }

    await publishLogAndPersist(
      crawlId,
      "info",
      `Peak RSS observed during crawl job: ${(memoryLogger.getPeakRssBytes() / 1024 / 1024).toFixed(1)}MB`
    );

    await pruneOldArchives(siteId, site.maxArchivesToKeep ?? Number.POSITIVE_INFINITY, crawlId);
    console.log(`[Worker] Archive completed: ${crawlId} (${finalStatus})`);
  });
}

async function processCrawlJob(job: Job<CrawlJobData>) {
  return runExclusiveWorkerJob(async () => {
    const { siteId, crawlId } = job.data;
    const maxAttempts = Math.max(1, job.opts.attempts ?? 1);
    const currentAttempt = job.attemptsMade + 1;
    const isRetry = currentAttempt > 1;
    const previousFailedReason = job.failedReason;

    console.log(
      `[Worker] ${isRetry ? "RETRY" : "START"} crawl job: ${crawlId} (attempt ${currentAttempt}/${maxAttempts}) for site: ${siteId}${previousFailedReason ? ` | Previous error: ${previousFailedReason.substring(0, 200)}` : ""}`
    );

    const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
    if (!site) {
      throw new UnrecoverableError(`Site not found: ${siteId}`);
    }

    const crawl = await db.query.crawls.findFirst({ where: eq(crawls.id, crawlId) });
    if (!crawl) {
      throw new UnrecoverableError(`Crawl not found: ${crawlId}`);
    }

    if (!isCrawlQueueStatus(crawl.status)) {
      console.log(`[Worker] Skipping crawl ${crawlId}; current status is ${crawl.status}`);
      return;
    }

    await db
      .update(crawls)
      .set({ status: "running", startedAt: crawl.startedAt ?? new Date(), errorMessage: null })
      .where(eq(crawls.id, crawlId));

    if (isRetry) {
      const restartMessage = previousFailedReason
        ? `RETRY attempt ${currentAttempt}/${maxAttempts} after failure: ${previousFailedReason.substring(0, 300)}${previousFailedReason.length > 300 ? "..." : ""}`
        : `RETRY attempt ${currentAttempt}/${maxAttempts} (previous failure reason not available)`;
      await publishLogAndPersist(crawlId, "warn", restartMessage);
    }

    await publishLogAndPersist(
      crawlId,
      "info",
      `Starting crawl of ${site.url}${isRetry ? ` (attempt ${currentAttempt}/${maxAttempts})` : ""}`
    );

    const memoryLogger = createWorkerMemoryLogger(crawlId, (level, message) => publishLogAndPersist(crawlId, level, message));
    await memoryLogger.snapshot("crawl job start", { siteId, attempt: currentAttempt });

    const maxDurationMs = parsePositiveIntEnv("CRAWL_MAX_DURATION_MS", 45 * 60 * 1000);
    const progressPersistIntervalMs = parsePositiveIntEnv("CRAWL_PROGRESS_PERSIST_INTERVAL_MS", 1500);
    const statusCheckIntervalMs = parsePositiveIntEnv("CRAWL_STATUS_CHECK_INTERVAL_MS", 3000);
    const maxSiteConcurrency = parsePositiveIntEnv("MAX_SITE_CONCURRENCY", 5);
    const crawlConcurrency = Math.max(1, Math.min(site.concurrency ?? 5, maxSiteConcurrency));
    const globalDownloadBlacklist = await readGlobalDownloadBlacklist();
    const combinedDownloadBlacklist = Array.from(new Set([...(globalDownloadBlacklist ?? []), ...(site.downloadBlacklist ?? [])]));

    if ((site.concurrency ?? 5) > crawlConcurrency) {
      await publishLogAndPersist(crawlId, "warn", `Site concurrency capped at ${crawlConcurrency} for worker stability`);
    }

    let lastProgressPersistAt = 0;
    let lastStatusCheckAt = 0;
    let cancelled = false;
    let crawlPhaseComplete = false;

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort(
        new CrawlTimeoutError(`Crawl exceeded max duration of ${Math.round(maxDurationMs / 60000)} minutes`)
      );
    }, maxDurationMs);

    const assertCrawlIsActive = async (force = false): Promise<void> => {
      if (!crawlPhaseComplete && timeoutController.signal.aborted) {
        throw new CrawlTimeoutError(`Crawl exceeded max duration of ${Math.round(maxDurationMs / 60000)} minutes`);
      }

      if (cancelled) {
        throw new CrawlCancelledError();
      }

      const now = Date.now();
      if (!force && now - lastStatusCheckAt < statusCheckIntervalMs) {
        return;
      }

      lastStatusCheckAt = now;
      const latest = await db.query.crawls.findFirst({ where: eq(crawls.id, crawlId) });
      if (!latest) {
        throw new CrawlCancelledError("Crawl record deleted while processing");
      }
      if (latest.status === "cancelled") {
        cancelled = true;
        throw new CrawlCancelledError();
      }
    };

    const outputDir = await storage.createTempDir(crawlId);
    let shouldResume = false;
    const stateFile = `${outputDir}/.crawl-state.json`;
    try {
      if (await fs.access(stateFile).then(() => true).catch(() => false)) {
        const stateData = await fs.readFile(stateFile, "utf-8");
        const state = JSON.parse(stateData);
        if (state && Array.isArray(state.succeeded) && Array.isArray(state.failed)) {
          shouldResume = true;
          await publishLogAndPersist(
            crawlId,
            "info",
            `Found existing crawl state: ${state.succeeded.length} succeeded, ${state.failed.length} failed URLs will be skipped`
          );
        } else {
          await publishLogAndPersist(crawlId, "warn", "Found state file but it has invalid format, starting fresh");
        }
      } else if (isRetry) {
        await publishLogAndPersist(
          crawlId,
          "error",
          `Expected state file for retry but none found at ${stateFile}. Crawl will restart from beginning.`
        );
      } else {
        await publishLogAndPersist(crawlId, "info", `Starting fresh crawl - no previous state found at ${stateFile}`);
      }
    } catch (error) {
      await publishLogAndPersist(crawlId, "error", `Failed to read state file: ${(error as Error).message}. Starting fresh.`);
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
        signal: timeoutController.signal,
        shouldAbort: async () => {
          await assertCrawlIsActive();
          return false;
        },
        onProgress: async (progress: CrawlProgress) => {
          await publishEvent(crawlId, { type: "progress", ...progress });
          const now = Date.now();
          const isFinalProgress = !progress.currentUrl;
          if (isFinalProgress || now - lastProgressPersistAt >= progressPersistIntervalMs) {
            lastProgressPersistAt = now;
            await db.update(crawls).set({
              totalPages: progress.total,
              succeededPages: progress.succeeded,
              failedPages: progress.failed,
            }).where(eq(crawls.id, crawlId));
          }
          await assertCrawlIsActive();
        },
        onLog: async (level: LogLevel, message: string, url?: string) => {
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
          await db.insert(crawlLogs).values({ crawlId, level, message, url });
        },
        onMemorySnapshot: async (label: string, snapshot: MemorySnapshot, peakRssBytes: number) => {
          await publishEvent(crawlId, {
            type: "log",
            level: "info",
            message: formatMemorySnapshot(label, snapshot, peakRssBytes),
            timestamp: new Date().toISOString(),
          });
        },
      } as any);

      crawlPhaseComplete = true;
      await assertCrawlIsActive(true);
      await memoryLogger.snapshot("after crawl", { total: result.total, succeeded: result.succeeded, failed: result.failed });

      await db.update(crawls).set({ status: "archiving" }).where(eq(crawls.id, crawlId));
      await enqueueArchiveJob({
        siteId,
        crawlId,
        finalStatus: "completed",
        crawlResult: {
          total: result.total,
          succeeded: result.succeeded,
          failed: result.failed,
          durationMs: result.durationMs,
        },
      });
      await publishLogAndPersist(crawlId, "info", "Crawl phase finished; queued archive job");
      await publishLogAndPersist(
        crawlId,
        "info",
        `Peak RSS observed during crawl phase: ${(memoryLogger.getPeakRssBytes() / 1024 / 1024).toFixed(1)}MB`
      );
    } catch (error) {
      console.error(`[Worker] Crawl failed: ${crawlId}`, error);
      await memoryLogger.snapshot("crawl failure", { message: (error as Error).message });

      const isCancelled = error instanceof CrawlCancelledError;
      const isTimeout = error instanceof CrawlTimeoutError;
      const errorMessage = (error as Error).message;

      if (isTimeout) {
        await db.update(crawls).set({ status: "archiving", errorMessage }).where(eq(crawls.id, crawlId));
        await publishLogAndPersist(
          crawlId,
          "warn",
          `Crawl timed out after ${Math.round(maxDurationMs / 60000)} minutes. Queueing archive job for partial results...`
        );
        await enqueueArchiveJob({ siteId, crawlId, finalStatus: "timed_out", errorMessage });
        return;
      }

      const status = isCancelled ? "cancelled" : "failed";
      await db.update(crawls).set({ status, completedAt: new Date(), errorMessage }).where(eq(crawls.id, crawlId));
      await publishLogAndPersist(
        crawlId,
        isCancelled ? "warn" : "error",
        isCancelled ? `Crawl cancelled: ${errorMessage}` : `Crawl failed: ${errorMessage}`
      );

      if (isCancelled) {
        await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
        return;
      }

      const hasMoreRetries = currentAttempt < maxAttempts;
      if (hasMoreRetries) {
        await publishLogAndPersist(crawlId, "warn", `Preserving partial crawl output for retry ${currentAttempt + 1}/${maxAttempts}`);
      } else {
        await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  });
}

async function reconcileOrphanedCrawls(): Promise<void> {
  const orphanGraceMs = parsePositiveIntEnv("ORPHAN_CRAWL_GRACE_MS", 5 * 60 * 1000);
  const cutoff = new Date(Date.now() - orphanGraceMs);

  const possiblyOrphaned = await db.query.crawls.findMany({
    where: and(
      inArray(crawls.status, ["pending", "running", "archiving", "uploading"]),
      lte(crawls.createdAt, cutoff)
    ),
    limit: 50,
  });

  if (possiblyOrphaned.length === 0) {
    return;
  }

  console.log(`[Worker] Orphan check: Found ${possiblyOrphaned.length} crawls older than ${orphanGraceMs}ms in active states`);

  for (const crawl of possiblyOrphaned) {
    const crawlQueueJob = await crawlQueue.getJob(crawl.id);
    const archiveQueueJob = await archiveQueue.getJob(crawl.id);
    const ageMinutes = crawl.createdAt
      ? Math.round((Date.now() - crawl.createdAt.getTime()) / 60000)
      : 0;

    const expectedQueueJob = isArchiveQueueStatus(crawl.status) ? archiveQueueJob : crawlQueueJob;
    if (!expectedQueueJob) {
      if (crawl.status && crawl.siteId && isCrawlQueueStatus(crawl.status)) {
        try {
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

          await crawlQueue.add("crawl", { siteId: crawl.siteId, crawlId: crawl.id }, { jobId: crawl.id, attempts: 1 });
          const requeueMsg = `RE-ENQUEUED orphaned ${crawl.status} crawl (age: ${ageMinutes}min, reason: worker crash/restart)${stateInfo}`;
          console.warn(`[Worker] ${requeueMsg}: ${crawl.id}`);
          await publishLogAndPersist(crawl.id, "warn", `Orphan reconciliation: ${requeueMsg}`);
          continue;
        } catch (error) {
          console.error(`[Worker] Failed to re-enqueue orphaned crawl ${crawl.id}`, error);
        }
      }

      if (crawl.status && crawl.siteId && isArchiveQueueStatus(crawl.status)) {
        try {
          await enqueueArchiveJob({
            siteId: crawl.siteId,
            crawlId: crawl.id,
            finalStatus: crawl.status === "archiving" || crawl.status === "uploading" ? (crawl.errorMessage ? "timed_out" : "completed") : "completed",
            errorMessage: crawl.errorMessage,
          });
          const requeueMsg = `RE-ENQUEUED orphaned ${crawl.status} archive job (age: ${ageMinutes}min, reason: worker crash/restart)`;
          console.warn(`[Worker] ${requeueMsg}: ${crawl.id}`);
          await publishLogAndPersist(crawl.id, "warn", `Orphan reconciliation: ${requeueMsg}`);
          continue;
        } catch (error) {
          console.error(`[Worker] Failed to re-enqueue orphaned archive ${crawl.id}`, error);
        }
      }

      const failMsg = `Crawl marked failed automatically: no queue job found for ${crawl.status} crawl (age: ${ageMinutes}min)`;
      console.warn(`[Worker] ${failMsg}: ${crawl.id}`);
      await publishLogAndPersist(crawl.id, "error", `Orphan reconciliation: ${failMsg}`);

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

    const state = await expectedQueueJob.getState();
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
    await publishLogAndPersist(crawl.id, "error", `Orphan reconciliation: ${terminalMsg}`);

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

function attachWorkerLogging<T>(worker: Worker<T>, label: string, reconcileTimer: ReturnType<typeof setInterval>) {
  worker.on("completed", (completedJob) => {
    console.log(`[Worker] ${label} job completed: ${completedJob.id} (attempt ${completedJob.attemptsMade + 1}/${completedJob.opts.attempts ?? 1})`);
  });

  worker.on("failed", (failedJob, error) => {
    if (!failedJob) {
      console.error(`[Worker] ${label} job failed (no job data):`, error.message);
      return;
    }
    const attempts = failedJob.attemptsMade + 1;
    const maxAttempts = failedJob.opts.attempts ?? 1;
    const willRetry = attempts < maxAttempts;
    console.error(
      `[Worker] ${label} job failed: ${failedJob.id} (attempt ${attempts}/${maxAttempts})${willRetry ? " - Will retry" : " - Final attempt"}`,
      error.message
    );
  });

  worker.on("stalled", (jobId) => {
    console.warn(`[Worker] ${label} job stalled: ${jobId} - Will be handled by orphan reconciliation`);
  });

  worker.on("error", (error) => {
    console.error(`[Worker] ${label} worker error:`, error);
  });

  worker.on("closed", () => {
    clearInterval(reconcileTimer);
  });
}

export function startWorker() {
  const workerConcurrency = parsePositiveIntEnv("WORKER_CRAWL_CONCURRENCY", 1);
  const archiveConcurrency = parsePositiveIntEnv("WORKER_ARCHIVE_CONCURRENCY", 1);
  // Long crawl/upload/zip phases can starve lock renewal under heavy CPU pressure.
  // Use conservative defaults to avoid duplicate retry attempts on healthy long-running jobs.
  const lockDuration = parsePositiveIntEnv("WORKER_LOCK_DURATION_MS", 900000);
  const stalledInterval = parsePositiveIntEnv("WORKER_STALLED_INTERVAL_MS", 120000);

  const crawlWorker = new Worker<CrawlJobData>("crawl-jobs", processCrawlJob, {
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

  const archiveWorker = new Worker<ArchiveJobData>("archive-jobs", processArchiveJob, {
    connection: workerConnection,
    concurrency: archiveConcurrency,
    lockDuration,
    stalledInterval,
    maxStalledCount: 0,
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

  attachWorkerLogging(crawlWorker, "crawl", reconcileTimer);
  attachWorkerLogging(archiveWorker, "archive", reconcileTimer);

  console.log(
    `[Worker] Started crawl worker (concurrency=${workerConcurrency}) and archive worker (concurrency=${archiveConcurrency}, lockDuration=${lockDuration}ms)`
  );

  return {
    async close() {
      clearInterval(reconcileTimer);
      await archiveWorker.close();
      await crawlWorker.close();
    },
  };
}
