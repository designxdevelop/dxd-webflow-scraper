import { Hono } from "hono";
import { eq, desc, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { crawls, crawlLogs, sites } from "../db/schema.js";
import { getStorage } from "@dxd/storage";
import archiver from "archiver";
import { Readable } from "node:stream";

const app = new Hono();

// List crawls with optional filters
app.get("/", async (c) => {
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

// Cancel a crawl
app.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");

  const crawl = await db.query.crawls.findFirst({
    where: eq(crawls.id, id),
  });

  if (!crawl) {
    return c.json({ error: "Crawl not found" }, 404);
  }

  if (crawl.status !== "pending" && crawl.status !== "running") {
    return c.json({ error: "Crawl cannot be cancelled" }, 400);
  }

  const [updated] = await db
    .update(crawls)
    .set({
      status: "cancelled",
      completedAt: new Date(),
    })
    .where(eq(crawls.id, id))
    .returning();

  return c.json({ crawl: updated });
});

// Download crawl as zip
app.get("/:id/download", async (c) => {
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

  const storage = getStorage();
  const files = await storage.listFiles(crawl.outputPath);

  if (files.length === 0) {
    return c.json({ error: "No files found" }, 404);
  }

  // Create zip archive
  const archive = archiver("zip", { zlib: { level: 9 } });
  const siteName = crawl.site?.name || "archive";
  const filename = `${siteName}-${crawl.id.slice(0, 8)}.zip`;

  c.header("Content-Type", "application/zip");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);

  // Add files to archive
  for (const file of files) {
    const content = await storage.readFile(file);
    const relativePath = file.replace(`${crawl.outputPath}/`, "");
    archive.append(content, { name: relativePath });
  }

  archive.finalize();

  // Convert archive to web stream
  const webStream = Readable.toWeb(archive) as ReadableStream;
  return new Response(webStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

export const crawlsRoutes = app;
