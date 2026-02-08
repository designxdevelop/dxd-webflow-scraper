import { Hono } from "hono";
import { eq, desc, and } from "drizzle-orm";
import { crawls, crawlLogs, sites } from "../db/schema.js";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env.js";

const app = new Hono<AppEnv>();
const DOWNLOAD_FAILURE_PATTERN = /(?:Could not|Failed to)\s+download\s+(https?:\/\/\S+)/i;
const TRAILING_URL_PUNCTUATION = /[),.;:]+$/;

function sanitizeFailedUrlCandidate(raw: string): string {
  return raw.trim().replace(TRAILING_URL_PUNCTUATION, "");
}

function normalizeUrlForBlacklist(raw: string): string | null {
  try {
    const parsed = new URL(sanitizeFailedUrlCandidate(raw));
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractFailedDownloadUrl(log: { message: string; url?: string | null }): string | null {
  if (log.url) {
    return normalizeUrlForBlacklist(log.url);
  }

  const match = DOWNLOAD_FAILURE_PATTERN.exec(log.message);
  if (!match) {
    return null;
  }

  const raw = sanitizeFailedUrlCandidate(match[1]);
  return normalizeUrlForBlacklist(raw);
}

// List crawls with optional filters
app.get("/", async (c) => {
  const db = c.get("db");
  const siteId = c.req.query("siteId");
  const status = c.req.query("status");
  const limit = parseInt(c.req.query("limit") || "50");
  const offset = parseInt(c.req.query("offset") || "0");

  const conditions = [];
  if (siteId) {
    conditions.push(eq(crawls.siteId, siteId));
  }
  if (status) {
    conditions.push(eq(crawls.status, status));
  }

  const allCrawls = await db.query.crawls.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(crawls.createdAt),
    limit,
    offset,
    with: {
      site: true,
    },
  });

  return c.json({ crawls: allCrawls });
});

// Get single crawl with logs
app.get("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const crawl = await db.query.crawls.findFirst({
    where: eq(crawls.id, id),
    with: {
      site: true,
      logs: {
        orderBy: desc(crawlLogs.createdAt),
        limit: 100,
      },
    },
  });

  if (!crawl) {
    return c.json({ error: "Crawl not found" }, 404);
  }

  return c.json({ crawl });
});

// Get crawl logs
app.get("/:id/logs", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const limit = parseInt(c.req.query("limit") || "100");
  const offset = parseInt(c.req.query("offset") || "0");

  const logs = await db.query.crawlLogs.findMany({
    where: eq(crawlLogs.crawlId, id),
    orderBy: desc(crawlLogs.createdAt),
    limit,
    offset,
  });

  return c.json({ logs });
});

// Analyze failed downloads and return blacklist suggestions
app.get("/:id/download-suggestions", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const minCount = Math.max(1, parseInt(c.req.query("minCount") || "3", 10));
  const limit = Math.max(1, Math.min(25, parseInt(c.req.query("limit") || "10", 10)));

  const crawl = await db.query.crawls.findFirst({
    where: eq(crawls.id, id),
    with: {
      site: true,
      logs: {
        orderBy: desc(crawlLogs.createdAt),
        limit: 1000,
      },
    },
  });

  if (!crawl) {
    return c.json({ error: "Crawl not found" }, 404);
  }

  const counts = new Map<string, number>();
  for (const log of crawl.logs) {
    const failedUrl = extractFailedDownloadUrl(log);
    if (!failedUrl) {
      continue;
    }
    counts.set(failedUrl, (counts.get(failedUrl) ?? 0) + 1);
  }

  const existing = new Set((crawl.site?.downloadBlacklist ?? []).map((entry) => entry.trim()));
  const suggestions = Array.from(counts.entries())
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url, count]) => ({
      url,
      count,
      alreadyBlacklisted: existing.has(url),
    }));

  return c.json({
    crawlId: crawl.id,
    siteId: crawl.siteId,
    totalDistinctFailures: counts.size,
    suggestions,
  });
});

const applyDownloadSuggestionsSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(200),
});

// Apply blacklist suggestions to the crawl's site
app.post(
  "/:id/download-suggestions/apply",
  zValidator("json", applyDownloadSuggestionsSchema),
  async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const crawl = await db.query.crawls.findFirst({
      where: eq(crawls.id, id),
      with: {
        site: true,
      },
    });

    if (!crawl || !crawl.siteId || !crawl.site) {
      return c.json({ error: "Crawl or site not found" }, 404);
    }

    const normalizedIncoming = body.urls
      .map((url) => normalizeUrlForBlacklist(url))
      .filter((url): url is string => Boolean(url));

    const merged = Array.from(
      new Set([...(crawl.site.downloadBlacklist ?? []), ...normalizedIncoming])
    );

    const [site] = await db
      .update(sites)
      .set({
        downloadBlacklist: merged,
        updatedAt: new Date(),
      })
      .where(eq(sites.id, crawl.siteId))
      .returning();

    return c.json({
      success: true,
      added: merged.length - (crawl.site.downloadBlacklist?.length ?? 0),
      site,
    });
  }
);

// Cancel a crawl
app.post("/:id/cancel", async (c) => {
  const db = c.get("db");
  const queue = c.get("queue");
  const id = c.req.param("id");

  const crawl = await db.query.crawls.findFirst({
    where: eq(crawls.id, id),
  });

  if (!crawl) {
    return c.json({ error: "Crawl not found" }, 404);
  }

  if (crawl.status !== "pending" && crawl.status !== "running" && crawl.status !== "uploading") {
    return c.json({ error: "Crawl cannot be cancelled" }, 400);
  }

  if (crawl.status === "pending") {
    await queue.removeCrawlJob(id);
  }

  const [updated] = await db
    .update(crawls)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      errorMessage: "Cancelled by user",
    })
    .where(eq(crawls.id, id))
    .returning();

  return c.json({ crawl: updated });
});

// Download crawl as zip — archive is prebuilt and stored by the worker.
app.get("/:id/download", async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const id = c.req.param("id");

  const crawl = await db.query.crawls.findFirst({
    where: eq(crawls.id, id),
    with: {
      site: true,
    },
  });

  if (!crawl) {
    return c.json({ error: "Crawl not found" }, 404);
  }

  if (crawl.status !== "completed" || !crawl.outputPath) {
    return c.json({ error: "Crawl output not available" }, 400);
  }

  const siteName = crawl.site?.name || "archive";
  const filename = `${siteName}-${crawl.id.slice(0, 8)}.zip`;
  const archivePath = crawl.outputPath.endsWith(".zip") ? crawl.outputPath : `${crawl.outputPath}.zip`;

  try {
    const archiveExists = await storage.exists(archivePath);
    if (!archiveExists) {
      return c.json({ error: "Archive not found" }, 404);
    }

    return new Response(storage.readStream(archivePath), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("[download] Failed to read archive from storage", {
      crawlId: id,
      archivePath,
      error: (error as Error).message,
    });
    return c.json({ error: "Failed to load archive from storage" }, 500);
  }
});

export const crawlsRoutes = app;
