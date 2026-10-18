import { eq, and, inArray, desc, isNotNull, notInArray } from "drizzle-orm";
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
import { db, sites, crawls, crawlLogs, settings, sitePublications, siteDomains } from "./db.js";
import fs from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import { captureMemorySnapshot, formatMemorySnapshot, type MemorySnapshot } from "./memory.js";

const storage = getStorage();

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

interface PublicationJobData {
  siteId: string;
  crawlId: string;
  publicationId: string;
  activate: boolean;
  autoPublish?: boolean;
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

function getArchiveStoragePath(outputPath: string): string {
  return outputPath.endsWith(".zip") ? outputPath : `${outputPath}.zip`;
}

function toSafePublishedKey(prefix: string, zipEntryPath: string): string | null {
  const normalized = path.posix.normalize(zipEntryPath.replace(/\\/g, "/"));
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return `${prefix.replace(/\/+$/, "")}/${normalized}`;
}

// Reads the zip from R2 with ranged GETs and streams each entry back to R2: nothing hits disk.
async function publishZipArchiveToR2(archivePath: string, prefix: string) {
  let fileCount = 0;
  let totalBytes = 0;

  {
    await storage.deleteDir(prefix).catch(() => undefined);

    const directory = await storage.openZip(archivePath);
    for (const entry of directory.files) {
      if (entry.type !== "File") continue;

      const key = toSafePublishedKey(prefix, entry.path);
      if (!key) continue;

      await storage.writeStream(
        key,
        entry.stream(),
        { totalSize: entry.uncompressedSize }
      );
      fileCount += 1;
      totalBytes += entry.uncompressedSize;
    }
  }

  if (fileCount === 0) {
    throw new Error("Archive did not contain any publishable files");
  }

  return { fileCount, totalBytes };
}

// Zip is streamed straight into R2 as it is built (one multipart part in memory, no zip on disk).
async function uploadArchiveFromTempDir(
  crawlId: string,
  outputDir: string,
  options?: {
    zlibLevel?: number;
    onBeforeUpload?: (sourceBytes: number) => Promise<void>;
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

  await options?.assertNotCancelled?.();
  await options?.onBeforeUpload?.(sourceBytes);

  // Upload progress is tracked against source bytes; the zip size is unknown until it is done.
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
  archive.on("warning", (error: Error) => {
    console.warn("[Worker] Archive warning", { crawlId, outputDir, error: error.message });
  });

  let lastDbUpdate = 0;
  const uploadOptions = {
    partDelayMs: 50, // smooth out traffic between 16MB parts (TCP_OVERWINDOW)
    onProgress: async (progress: MultipartUploadProgress) => {
      await options?.assertNotCancelled?.();
      const now = Date.now();
      if (now - lastDbUpdate < 1000) return;
      lastDbUpdate = now;
      await db
        .update(crawls)
        .set({
          uploadTotalBytes: Math.max(sourceBytes, progress.uploadedBytes),
          uploadUploadedBytes: progress.uploadedBytes,
          uploadCurrentFile: `archive.zip (part ${progress.partNumber})`,
        })
        .where(eq(crawls.id, crawlId));
    },
  };

  const upload = storage.writeStream(
    archivePath,
    archive,
    uploadOptions
  );
  try {
    // Feed files in; archiver back-pressures on the upload stream. If the upload fails, stop feeding.
    const feed = (async () => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        if (i % 50 === 0) {
          await options?.assertNotCancelled?.();
        }
        archive.file(file, { name: path.relative(outputDir, file).replace(/\\/g, "/") });
      }
      await archive.finalize();
    })();
    await Promise.all([upload.catch((error) => { archive.abort(); throw error; }), feed]);

    await options?.assertNotCancelled?.();
    const outputSize = await storage.getSize(archivePath);
    await options?.onAfterUpload?.(outputSize);

    await db
      .update(crawls)
      .set({
        uploadTotalBytes: outputSize,
        uploadUploadedBytes: outputSize,
        uploadFilesUploaded: 1,
        uploadCurrentFile: "archive.zip",
      })
      .where(eq(crawls.id, crawlId));

    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    return { archivePath, outputSize };
  } catch (error) {
    // abort() ends the stream, so a truncated upload may still complete; wait, then delete it.
    archive.abort();
    await upload.catch(() => undefined);
    await storage.deleteDir(archivePath).catch(() => undefined);
    throw error;
  } finally {
    archive.removeAllListeners();
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
      await publishLogAndPersist(currentCrawlId, "info", `Pruned old archive from crawl ${oldCrawl.id}`);
    }
  }
}

function isCrawlQueueStatus(status: string | null | undefined): boolean {
  return status === "pending" || status === "running";
}

function isArchiveQueueStatus(status: string | null | undefined): boolean {
  return status === "archiving" || status === "uploading";
}

function isPublicationQueueStatus(status: string | null | undefined): boolean {
  return status === "pending" || status === "publishing";
}

async function publishLogAndPersist(crawlId: string, level: LogLevel, message: string): Promise<void> {

  await db.insert(crawlLogs).values({
    crawlId,
    level,
    message,
  });
}

async function enqueueAutoPublication(siteId: string, crawlId: string): Promise<void> {
  const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
  if (!site?.hostingAutoPublish) {
    return;
  }

  // Picked up by the drain loop in index.ts.
  const publicationId = crypto.randomUUID();
  await db.insert(sitePublications).values({
    id: publicationId,
    siteId,
    crawlId,
    status: "pending",
    r2Prefix: `published/${siteId}/${publicationId}`,
  });
}

async function resolveArchiveResult(job: ArchiveJobData) {
  const crawl = await db.query.crawls.findFirst({ where: eq(crawls.id, job.crawlId) });
  if (!crawl) {
    throw new Error(`Crawl not found: ${job.crawlId}`);
  }

  const site = await db.query.sites.findFirst({ where: eq(sites.id, job.siteId) });
  if (!site) {
    throw new Error(`Site not found: ${job.siteId}`);
  }

  return { crawl, site };
}

export async function processPublicationJob(job: PublicationJobData): Promise<void> {
  {
    const { siteId, crawlId, publicationId, activate, autoPublish } = job;

    await db
      .update(sitePublications)
      .set({ status: "publishing", errorMessage: null, updatedAt: new Date() })
      .where(eq(sitePublications.id, publicationId));

    try {
      const publication = await db.query.sitePublications.findFirst({
        where: and(
          eq(sitePublications.id, publicationId),
          eq(sitePublications.siteId, siteId),
          eq(sitePublications.crawlId, crawlId)
        ),
      });
      if (!publication) {
        throw new Error(`Publication ${publicationId} not found`);
      }

      const crawl = await db.query.crawls.findFirst({
        where: and(eq(crawls.id, crawlId), eq(crawls.siteId, siteId)),
      });
      if (!crawl || crawl.status !== "completed" || !crawl.outputPath) {
        throw new Error(`Crawl ${crawlId} is not publishable`);
      }

      const archivePath = getArchiveStoragePath(crawl.outputPath);
      const archiveExists = await storage.exists(archivePath);
      if (!archiveExists) {
        throw new Error(`Archive not found at ${archivePath}`);
      }

      const result = await publishZipArchiveToR2(archivePath, publication.r2Prefix);
      await db
        .update(sitePublications)
        .set({
          status: "published",
          fileCount: result.fileCount,
          totalBytes: result.totalBytes,
          publishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sitePublications.id, publicationId));

      if (activate) {
        if (autoPublish) {
          const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
          if (!site?.hostingAutoPublish) {
            return;
          }
        }

        await db
          .update(siteDomains)
          .set({ activePublicationId: publicationId, updatedAt: new Date() })
          .where(eq(siteDomains.siteId, siteId));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown publication error";
      await db
        .update(sitePublications)
        .set({ status: "failed", errorMessage: message, updatedAt: new Date() })
        .where(eq(sitePublications.id, publicationId));
      throw error;
    }
  }
}

async function processArchiveJob(job: ArchiveJobData) {
  {
    const { crawlId, siteId, finalStatus, errorMessage, crawlResult } = job;
    const { crawl, site } = await resolveArchiveResult(job);

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
          onBeforeUpload: async (sourceBytes) => {
            await memoryLogger.snapshot("before zip upload", { sourceBytes });
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
        const cancelMessage = error instanceof Error ? error.message : "Archive cancelled";
        await publishLogAndPersist(crawlId, "warn", `Archive aborted: ${cancelMessage}`);
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
    if (finalStatus === "completed") {
      try {
        await enqueueAutoPublication(siteId, crawlId);
        await publishLogAndPersist(crawlId, "info", "Queued hosted backup publish for latest successful crawl");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown hosted backup publish error";
        await publishLogAndPersist(crawlId, "warn", `Failed to queue hosted backup publish: ${message}`);
      }
    }

    console.log(`[Worker] Archive completed: ${crawlId} (${finalStatus})`);
  }
}

// Crawl, then archive + upload inline. Container disk is ephemeral, so no resume/retry.
export async function processCrawlJob(job: CrawlJobData) {
  {
    const { siteId, crawlId } = job;
    console.log(`[Worker] START crawl job: ${crawlId} for site: ${siteId}`);

    const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
    if (!site) {
      throw new Error(`Site not found: ${siteId}`);
    }

    const crawl = await db.query.crawls.findFirst({ where: eq(crawls.id, crawlId) });
    if (!crawl) {
      throw new Error(`Crawl not found: ${crawlId}`);
    }

    if (!isCrawlQueueStatus(crawl.status)) {
      console.log(`[Worker] Skipping crawl ${crawlId}; current status is ${crawl.status}`);
      return;
    }

    await db
      .update(crawls)
      .set({ status: "running", startedAt: crawl.startedAt ?? new Date(), errorMessage: null })
      .where(eq(crawls.id, crawlId));

    await publishLogAndPersist(crawlId, "info", `Starting crawl of ${site.url}`);

    const memoryLogger = createWorkerMemoryLogger(crawlId, (level, message) => publishLogAndPersist(crawlId, level, message));
    await memoryLogger.snapshot("crawl job start", { siteId });

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
        signal: timeoutController.signal,
        shouldAbort: async () => {
          await assertCrawlIsActive();
          return false;
        },
        onProgress: async (progress: CrawlProgress) => {
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
          await db.insert(crawlLogs).values({ crawlId, level, message, url });
        },
      } as any);

      crawlPhaseComplete = true;
      await assertCrawlIsActive(true);
      await memoryLogger.snapshot("after crawl", { total: result.total, succeeded: result.succeeded, failed: result.failed });

      await db.update(crawls).set({ status: "archiving" }).where(eq(crawls.id, crawlId));
      await publishLogAndPersist(crawlId, "info", "Crawl phase finished; archiving");
      await publishLogAndPersist(
        crawlId,
        "info",
        `Peak RSS observed during crawl phase: ${(memoryLogger.getPeakRssBytes() / 1024 / 1024).toFixed(1)}MB`
      );
      await processArchiveJob({
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
          `Crawl timed out after ${Math.round(maxDurationMs / 60000)} minutes. Archiving partial results...`
        );
        await processArchiveJob({ siteId, crawlId, finalStatus: "timed_out", errorMessage });
        return;
      }

      const status = isCancelled ? "cancelled" : "failed";
      await db.update(crawls).set({ status, completedAt: new Date(), errorMessage }).where(eq(crawls.id, crawlId));
      await publishLogAndPersist(
        crawlId,
        isCancelled ? "warn" : "error",
        isCancelled ? `Crawl cancelled: ${errorMessage}` : `Crawl failed: ${errorMessage}`
      );

      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
      if (!isCancelled) throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
