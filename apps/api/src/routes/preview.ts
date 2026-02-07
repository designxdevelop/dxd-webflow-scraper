import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { crawls } from "../db/schema.js";
import type { AppEnv } from "../env.js";

const app = new Hono<AppEnv>();
const PREVIEW_ROBOTS_DIRECTIVE = "noindex, nofollow, noarchive, nosnippet, noimageindex";

const encodedClientModuleUrlPattern = new RegExp(
  `(clientModuleUrl(?:&quot;|")\\s*:\\s*(?:&quot;|"))(\\/(?!\\/)[^"&<]+)((?:&quot;|"))`,
  "gi"
);
const encodedPublicPathPattern = new RegExp(
  `(publicPath(?:&quot;|")\\s*:\\s*(?:&quot;|"))(\\/(?!\\/)[^"&<]+)((?:&quot;|"))`,
  "gi"
);

/**
 * Get file extension from a path using pure string operations (no node:path).
 */
function getExtension(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  const basename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return basename.slice(dotIndex).toLowerCase();
}

function rewriteRootRelativeUrl(url: string, previewPrefix: string): string {
  if (!url.startsWith("/") || url.startsWith("//")) {
    return url;
  }
  if (url === previewPrefix || url.startsWith(`${previewPrefix}/`)) {
    return url;
  }
  return `${previewPrefix}${url}`;
}

function rewriteCssForPreview(css: string, crawlId: string): string {
  const previewPrefix = `/preview/${crawlId}`;

  return css
    .replace(/url\(\s*(['"]?)(\/(?!\/)[^'")]+)\1\s*\)/gi, (_match, quote: string, url: string) => {
      const rewritten = rewriteRootRelativeUrl(url, previewPrefix);
      return `url(${quote}${rewritten}${quote})`;
    })
    .replace(/(@import\s+)(['"])(\/(?!\/)[^'"]+)\2/gi, (_match, prefix: string, quote: string, url: string) => {
      const rewritten = rewriteRootRelativeUrl(url, previewPrefix);
      return `${prefix}${quote}${rewritten}${quote}`;
    })
    .replace(
      /(@import\s+url\(\s*)(['"]?)(\/(?!\/)[^'")]+)\2(\s*\))/gi,
      (_match, start: string, quote: string, url: string, end: string) => {
        const rewritten = rewriteRootRelativeUrl(url, previewPrefix);
        return `${start}${quote}${rewritten}${quote}${end}`;
      }
    );
}

function rewriteSrcsetValue(srcset: string, previewPrefix: string): string {
  return srcset
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return trimmed;
      const [url, ...rest] = trimmed.split(/\s+/);
      const rewritten = rewriteRootRelativeUrl(url, previewPrefix);
      return [rewritten, ...rest].join(" ");
    })
    .join(", ");
}

function rewriteHtmlForPreview(html: string, crawlId: string): string {
  const previewPrefix = `/preview/${crawlId}`;

  const rewritten = html
    .replace(
      /(\s(?:href|src|action|poster|content)\s*=\s*)(["'])([^"']+)\2/gi,
      (_match, prefix: string, quote: string, value: string) => {
        const rewritten = rewriteRootRelativeUrl(value, previewPrefix);
        return `${prefix}${quote}${rewritten}${quote}`;
      }
    )
    .replace(/(\s(?:href|src|action|poster|content)\s*=\s*)(\/[^\s>]+)/gi, (_match, prefix: string, value: string) => {
      const rewritten = rewriteRootRelativeUrl(value, previewPrefix);
      return `${prefix}${rewritten}`;
    })
    .replace(/(\ssrcset\s*=\s*)(["'])([^"']+)\2/gi, (_match, prefix: string, quote: string, value: string) => {
      const rewritten = rewriteSrcsetValue(value, previewPrefix);
      return `${prefix}${quote}${rewritten}${quote}`;
    })
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_match, start: string, css: string, end: string) => {
      return `${start}${rewriteCssForPreview(css, crawlId)}${end}`;
    })
    .replace(/(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/gi, (_match, prefix: string, quote: string, styleValue: string) => {
      return `${prefix}${quote}${rewriteCssForPreview(styleValue, crawlId)}${quote}`;
    })
    .replace(encodedClientModuleUrlPattern, (_match, prefix: string, value: string, suffix: string) => {
      const rewritten = rewriteRootRelativeUrl(value, `/preview/${crawlId}`);
      return `${prefix}${rewritten}${suffix}`;
    })
    .replace(encodedPublicPathPattern, (_match, prefix: string, value: string, suffix: string) => {
      const rewritten = rewriteRootRelativeUrl(value, `/preview/${crawlId}`);
      return `${prefix}${rewritten}${suffix}`;
    });

  if (/<meta\s+name=["']robots["']/i.test(rewritten)) {
    return rewritten.replace(
      /<meta\s+name=["']robots["'][^>]*>/i,
      `<meta name="robots" content="${PREVIEW_ROBOTS_DIRECTIVE}">`
    );
  }

  if (/<head\b[^>]*>/i.test(rewritten)) {
    return rewritten.replace(
      /<head\b[^>]*>/i,
      (headTag) => `${headTag}<meta name="robots" content="${PREVIEW_ROBOTS_DIRECTIVE}">`
    );
  }

  return `<meta name="robots" content="${PREVIEW_ROBOTS_DIRECTIVE}">${rewritten}`;
}

function rewriteJsonForPreview(json: string, crawlId: string): string {
  const previewPrefix = `/preview/${crawlId}`;

  return json.replace(
    /("(?:clientModuleUrl|publicPath)"\s*:\s*")(\/(?!\/)[^"]*)(")/gi,
    (_match, prefix: string, value: string, suffix: string) => {
      const rewritten = rewriteRootRelativeUrl(value, previewPrefix);
      return `${prefix}${rewritten}${suffix}`;
    }
  );
}

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

function getContentType(filePath: string): string {
  return mimeTypes[getExtension(filePath)] || "application/octet-stream";
}

function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const code = e.name || e.Code;
  return (
    code === "NotFound" ||
    code === "NoSuchKey" ||
    code === "NotFoundError" ||
    e.$metadata?.httpStatusCode === 404
  );
}

// Serve preview files from storage
app.get("/:crawlId/*", async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const crawlId = c.req.param("crawlId");
  const filePath = c.req.path.replace(`/preview/${crawlId}/`, "") || "index.html";
  const previewResponseHeaders = {
    "X-Robots-Tag": PREVIEW_ROBOTS_DIRECTIVE,
    "Referrer-Policy": "no-referrer",
  };

  if (filePath === "robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: {
        ...previewResponseHeaders,
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const crawl = await db.query.crawls.findFirst({
    where: eq(crawls.id, crawlId),
  });

  if (!crawl || !crawl.outputPath) {
    return c.json({ error: "Crawl not found" }, 404);
  }

  const fullPath = `${crawl.outputPath}/${filePath}`;

  try {
    const exists = await storage.exists(fullPath);
    if (!exists) {
      // Try with index.html for directory requests
      const indexPath = `${fullPath}/index.html`;
      const indexExists = await storage.exists(indexPath);
      if (indexExists) {
        const content = await storage.readFile(indexPath);
        const html = rewriteHtmlForPreview(content.toString("utf-8"), crawlId);
        return new Response(html, {
          headers: {
            ...previewResponseHeaders,
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      return c.json({ error: "File not found" }, 404);
    }

    const content = await storage.readFile(fullPath);
    const contentType = getContentType(filePath);

    if (contentType.includes("text/html")) {
      const html = rewriteHtmlForPreview(content.toString("utf-8"), crawlId);
      return new Response(html, {
        headers: { ...previewResponseHeaders, "Content-Type": contentType, "Cache-Control": "no-store" },
      });
    }

    if (contentType.includes("text/css")) {
      const css = rewriteCssForPreview(content.toString("utf-8"), crawlId);
      return new Response(css, {
        headers: {
          ...previewResponseHeaders,
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    if (contentType.includes("application/json")) {
      const json = rewriteJsonForPreview(content.toString("utf-8"), crawlId);
      return new Response(json, {
        headers: { ...previewResponseHeaders, "Content-Type": contentType, "Cache-Control": "no-store" },
      });
    }

    return new Response(new Uint8Array(content), {
      headers: {
        ...previewResponseHeaders,
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    if (isMissingFileError(error)) {
      return c.json({ error: "File not found" }, 404);
    }

    console.error("[preview] Failed to read preview file", {
      crawlId,
      filePath: fullPath,
      error: (error as Error).message,
    });
    return c.json({ error: "Failed to load preview file from storage" }, 500);
  }
});

export const previewRoutes = app;
