import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { crawls } from "../db/schema.js";
import { getStorage } from "@dxd/storage";
import path from "node:path";

const app = new Hono();

/**
 * Inject a <base> tag into HTML to make absolute asset paths work.
 * The scraped HTML uses absolute paths like /css/style.css, /images/logo.png
 * but when served at /preview/{crawlId}/, these paths would 404.
 * The <base> tag tells the browser to resolve all URLs relative to the crawl path.
 */
function injectBaseTag(html: string, basePath: string): string {
  const baseTag = `<base href="${basePath}">`;

  // Try to inject after <head> tag
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n    ${baseTag}`);
  }

  // Try to inject after <head ...> tag with attributes
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    return html.replace(headMatch[0], `${headMatch[0]}\n    ${baseTag}`);
  }

  // Fallback: inject at the very beginning
  return baseTag + html;
}

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
        let content = await storage.readFile(indexPath);
        // Inject base tag for HTML files
        const html = injectBaseTag(content.toString("utf-8"), `/preview/${crawlId}/`);
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }
      return c.json({ error: "File not found" }, 404);
    }

    const content = await storage.readFile(fullPath);
    const contentType = getContentType(filePath);

    // Inject base tag for HTML files so absolute asset paths work
    if (contentType.includes("text/html")) {
      const html = injectBaseTag(content.toString("utf-8"), `/preview/${crawlId}/`);
      return new Response(html, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

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
