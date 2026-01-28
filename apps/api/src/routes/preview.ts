import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { crawls } from "../db/schema.js";
import { getStorage } from "../storage/index.js";
import path from "node:path";

const app = new Hono();

// Serve preview files from storage
app.get("/:crawlId/*", async (c) => {
  const crawlId = c.req.param("crawlId");
  const filePath = c.req.path.replace(`/preview/${crawlId}/`, "") || "index.html";

  const crawl = await db.query.crawls.findFirst({
    where: eq(crawls.id, crawlId),
  });

  if (!crawl || !crawl.outputPath) {
    return c.json({ error: "Crawl not found" }, 404);
  }

  const storage = getStorage();
  const fullPath = `${crawl.outputPath}/${filePath}`;

  try {
    // Check if path exists
    const exists = await storage.exists(fullPath);
    if (!exists) {
      // Try with index.html for directory requests
      const indexPath = `${fullPath}/index.html`;
      const indexExists = await storage.exists(indexPath);
      if (indexExists) {
        const content = await storage.readFile(indexPath);
        return new Response(new Uint8Array(content), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }
      return c.json({ error: "File not found" }, 404);
    }

    const content = await storage.readFile(fullPath);
    const contentType = getContentType(filePath);

    return new Response(new Uint8Array(content), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    return c.json({ error: "File not found" }, 404);
  }
});

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".xml": "application/xml",
    ".txt": "text/plain; charset=utf-8",
  };

  return mimeTypes[ext] || "application/octet-stream";
}

export const previewRoutes = app;
