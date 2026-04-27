import { createDbClient, siteDomains } from "@dxd/db";
import { eq } from "drizzle-orm";

type Env = {
  HYPERDRIVE: Hyperdrive;
  STORAGE_BUCKET: R2Bucket;
};

let cachedDb: ReturnType<typeof createDbClient> | null = null;
let cachedConnectionString: string | null = null;

const NOT_FOUND_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();
    const db = getDb(env.HYPERDRIVE.connectionString);

    const domain = await db.query.siteDomains.findFirst({
      where: eq(siteDomains.hostname, hostname),
      with: { activePublication: true, site: true },
    });

    if (!domain || domain.status !== "active") {
      return new Response("Backup site is not active", { status: 404, headers: NOT_FOUND_HEADERS });
    }

    if (domain.redirectEnabled) {
      const targetOrigin = domain.redirectTargetOrigin || originForUrl(domain.site.url);
      if (!targetOrigin) {
        return new Response("Redirect target is not configured", { status: 500, headers: NOT_FOUND_HEADERS });
      }

      const redirectUrl = new URL(request.url);
      redirectUrl.protocol = new URL(targetOrigin).protocol;
      redirectUrl.host = new URL(targetOrigin).host;
      return Response.redirect(redirectUrl.toString(), 301);
    }

    if (!domain.activePublication) {
      return new Response("Backup publication is not active", { status: 404, headers: NOT_FOUND_HEADERS });
    }

    if (domain.activePublication.status !== "published") {
      return new Response("Backup publication is not ready", { status: 404, headers: NOT_FOUND_HEADERS });
    }

    const object = await findObject(env.STORAGE_BUCKET, domain.activePublication.r2Prefix, url.pathname);
    if (!object) {
      return new Response("Not Found", { status: 404, headers: NOT_FOUND_HEADERS });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", headers.get("Content-Type") || contentTypeForKey(object.key));
    headers.set("Cache-Control", cacheControlForKey(object.key));
    headers.set("ETag", object.httpEtag);
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");

    if (request.method === "HEAD") {
      return new Response(null, { headers });
    }

    return new Response(object.body, { headers });
  },
};

function originForUrl(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getDb(connectionString: string): ReturnType<typeof createDbClient> {
  if (!cachedDb || cachedConnectionString !== connectionString) {
    cachedDb = createDbClient(connectionString);
    cachedConnectionString = connectionString;
  }
  return cachedDb;
}

async function findObject(bucket: R2Bucket, prefix: string, pathname: string): Promise<R2ObjectBody | null> {
  const candidates = objectKeyCandidates(prefix, pathname);
  for (const key of candidates) {
    const object = await bucket.get(key);
    if (object) return object;
  }
  return null;
}

function objectKeyCandidates(prefix: string, pathname: string): string[] {
  const safePath = normalizeRequestPath(pathname);
  const base = prefix.replace(/\/+$/, "");
  const candidates = new Set<string>();

  if (!safePath || safePath === "/") {
    candidates.add(`${base}/index.html`);
    return [...candidates];
  }

  const withoutLeadingSlash = safePath.replace(/^\/+/, "");
  candidates.add(`${base}/${withoutLeadingSlash}`);

  if (safePath.endsWith("/")) {
    candidates.add(`${base}/${withoutLeadingSlash}index.html`);
  } else if (!withoutLeadingSlash.split("/").pop()?.includes(".")) {
    candidates.add(`${base}/${withoutLeadingSlash}/index.html`);
    candidates.add(`${base}/${withoutLeadingSlash}.html`);
  }

  return [...candidates];
}

function normalizeRequestPath(pathname: string): string {
  try {
    const decoded = decodeURIComponent(pathname);
    const segments = decoded.split("/").filter((segment) => segment && segment !== "." && segment !== "..");
    const normalized = `/${segments.join("/")}`;
    return decoded.endsWith("/") && normalized !== "/" ? `${normalized}/` : normalized;
  } catch {
    return "/";
  }
}

function cacheControlForKey(key: string): string {
  if (key.endsWith(".html") || key.endsWith("/index.html")) {
    return "public, max-age=60, stale-while-revalidate=300";
  }
  return "public, max-age=31536000, immutable";
}

function contentTypeForKey(key: string): string {
  const ext = key.toLowerCase().split(".").pop();
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
      return "application/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "ico":
      return "image/x-icon";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "txt":
      return "text/plain; charset=utf-8";
    case "xml":
      return "application/xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
