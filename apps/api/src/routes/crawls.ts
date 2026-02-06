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
  const archivePath = `${crawl.outputPath}.zip`;
  const siteName = crawl.site?.name || "archive";
  const filename = `${siteName}-${crawl.id.slice(0, 8)}.zip`;

  try {
    const archiveExists = await storage.exists(archivePath);
    if (archiveExists) {
      return new Response(storage.readStream(archivePath), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }
  } catch (error) {
    console.warn("[download] Failed to read prebuilt archive", {
      crawlId: id,
      archivePath,
      error: (error as Error).message,
    });
  }

  const outputPrefix = `${crawl.outputPath}/`;
  let files: string[] = [];

  try {
    files = (await storage.listFiles(crawl.outputPath)).filter((file) =>
      file.startsWith(outputPrefix)
    );
  } catch (error) {
    console.error("[download] Failed to list crawl files", {
      crawlId: id,
      outputPath: crawl.outputPath,
      error: (error as Error).message,
    });
    return c.json({ error: "Failed to load archive from storage" }, 500);
  }

  if (files.length === 0) {
    return c.json({ error: "No files found" }, 404);
  }

  // Create zip archive
  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("warning", (error) => {
    console.warn("[download] Archive warning", {
      crawlId: id,
      outputPath: crawl.outputPath,
      error: error.message,
    });
  });

  archive.on("error", (error) => {
    console.error("[download] Archive error", {
      crawlId: id,
      outputPath: crawl.outputPath,
      error: error.message,
    });
  });

  // Build the zip in the background so headers are returned immediately.
  void (async () => {
    try {
      for (const file of files) {
        const relativePath = file.slice(outputPrefix.length);
        const fileStream = storage.readStream(file);
        archive.append(Readable.fromWeb(fileStream), { name: relativePath });
      }

      await archive.finalize();
    } catch (error) {
      console.error("[download] Failed to stream crawl file", {
        crawlId: id,
        outputPath: crawl.outputPath,
        error: (error as Error).message,
      });
      archive.destroy(error as Error);
    }
  })();

  // Convert archive to web stream
  const webStream = Readable.toWeb(archive) as ReadableStream<Uint8Array>;
  return new Response(webStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

export const crawlsRoutes = app;
