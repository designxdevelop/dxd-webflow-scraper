import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");

const port = Number(process.env.PORT || 3000);
const host = "0.0.0.0";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function safeJoin(base, requestPath) {
  const targetPath = path.resolve(base, `.${requestPath}`);
  if (!targetPath.startsWith(path.resolve(base))) return null;
  return targetPath;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const requestPath = url.pathname;

    const filePath = safeJoin(distDir, requestPath);
    if (!filePath) {
      send(res, 400, "Bad request");
      return;
    }

    let stat = null;
    try {
      stat = await fs.stat(filePath);
    } catch {
      stat = null;
    }

    if (stat?.isDirectory()) {
      const indexPath = path.join(filePath, "index.html");
      try {
        const content = await fs.readFile(indexPath);
        send(res, 200, content, { "Content-Type": mimeTypes[".html"] });
        return;
      } catch {
        // Continue to SPA fallback below.
      }
    } else if (stat?.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || "application/octet-stream";
      const content = await fs.readFile(filePath);
      send(res, 200, content, { "Content-Type": contentType });
      return;
    }

    // SPA fallback for client-side routes.
    const indexPath = path.join(distDir, "index.html");
    const indexHtml = await fs.readFile(indexPath);
    send(res, 200, indexHtml, { "Content-Type": mimeTypes[".html"] });
  } catch (error) {
    console.error("Static server error:", error);
    send(res, 500, "Internal server error");
  }
});

server.listen(port, host, () => {
  console.log(`Web server listening on http://${host}:${port}`);
});
