import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import { AssetCategory } from "./types.js";
import { log } from "./logger.js";
import type { AssetCache } from "./asset-cache.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico"]);
const FONT_EXTS = new Set([".woff2", ".woff", ".ttf", ".otf", ".eot"]);
const MEDIA_EXTS = new Set([".mp4", ".webm", ".mov", ".mp3", ".wav"]);

type CategoryDir = Record<AssetCategory, string>;
type AssetDownloaderOptions = {
  downloadBlacklist?: string[];
  globalDownloadBlacklist?: string[];
};

const DEFAULT_GLOBAL_DOWNLOAD_BLACKLIST = [
  "https://js.partnerstack.com/partnerstack.min.js",
  "https://cdn.taboola.com/resources/codeless/codeless-events.js",
];

export class AssetDownloader {
  private cache = new Map<string, string>();
  private directPathCache = new Map<string, string>();
  private dirs: CategoryDir;
  private blacklist: string[];
  private blacklistLogCache = new Set<string>();
  /** B6: Optional cross-crawl disk cache. */
  private diskCache: AssetCache | null;

  constructor(private outputDir: string, diskCache?: AssetCache, options?: AssetDownloaderOptions) {
    this.diskCache = diskCache ?? null;
    this.blacklist = normalizeBlacklist([
      ...DEFAULT_GLOBAL_DOWNLOAD_BLACKLIST,
      ...(options?.globalDownloadBlacklist ?? []),
      ...(options?.downloadBlacklist ?? []),
    ]);
    this.dirs = {
      css: path.join(outputDir, "css"),
      js: path.join(outputDir, "js"),
      image: path.join(outputDir, "images"),
      font: path.join(outputDir, "fonts"),
      media: path.join(outputDir, "media"),
      html: path.join(outputDir, "html"),
    };
  }

  async init(): Promise<void> {
    await Promise.all(Object.values(this.dirs).map((dir) => fs.ensureDir(dir)));
  }

  async downloadAsset(assetUrl: string, category: AssetCategory): Promise<string> {
    const normalized = this.normalizeUrl(assetUrl);
    if (!normalized) return assetUrl;

    const blacklistedBy = this.matchBlacklistRule(normalized);
    if (blacklistedBy) {
      this.logBlacklistSkip(normalized, blacklistedBy);
      return normalized;
    }

    // Skip third-party tracking/analytics domains
    if (!this.shouldDownloadUrl(normalized)) {
      return normalized;
    }

    if (this.cache.has(normalized)) {
      return this.cache.get(normalized)!;
    }

    let relativePath: string | undefined;
    try {
      // B6: Check disk cache before network fetch
      if (this.diskCache && category !== "css" && category !== "js") {
        // Only cache binary assets — CSS/JS need URL rewriting which is context-dependent
        const cached = await this.diskCache.get(normalized);
        if (cached) {
          const contentType = null;
          relativePath = await this.writeBinaryAsset(cached, normalized, category, contentType);
          const webPath = `/${relativePath.replace(/\\+/g, "/")}`;
          this.cache.set(normalized, webPath);
          return webPath;
        }
      }

      const res = await fetch(normalized, {
        redirect: "follow",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
          accept: "*/*",
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      if (category === "css") {
        let cssContent = await res.text();
        cssContent = await this.rewriteCssUrls(cssContent, normalized);
        relativePath = await this.writeTextAsset(cssContent, normalized, "css", ".css");
      } else if (category === "js") {
        let jsContent = await res.text();
        jsContent = await this.rewriteJsUrls(jsContent, normalized);
        relativePath = await this.writeTextAsset(jsContent, normalized, "js", ".js");
      } else {
        const contentType = res.headers.get("content-type");
        const buffer = Buffer.from(await res.arrayBuffer());
        relativePath = await this.writeBinaryAsset(buffer, normalized, category, contentType);

        // B6: Write binary assets to disk cache for future crawls
        if (this.diskCache) {
          await this.diskCache.put(normalized, buffer).catch(() => {});
        }
      }
    } catch (error) {
      log.warn(`Could not download ${normalized}: ${(error as Error).message}`);
      return normalized;
    }

    const webPath = `/${relativePath.replace(/\\+/g, "/")}`;
    this.cache.set(normalized, webPath);
    return webPath;
  }

  async rewriteInlineCss(css: string, baseUrl: string): Promise<string> {
    return this.rewriteCssUrls(css, baseUrl);
  }

  async downloadAssetToPath(assetUrl: string, relativePath: string): Promise<string> {
    const normalized = this.normalizeUrl(assetUrl);
    if (!normalized) return assetUrl;

    const blacklistedBy = this.matchBlacklistRule(normalized);
    if (blacklistedBy) {
      this.logBlacklistSkip(normalized, blacklistedBy);
      return normalized;
    }

    if (!this.shouldDownloadUrl(normalized)) {
      return normalized;
    }

    const safeRelativePath = sanitizeRelativePath(relativePath);
    const cacheKey = `${normalized}::${safeRelativePath}`;
    if (this.directPathCache.has(cacheKey)) {
      return this.directPathCache.get(cacheKey)!;
    }

    const res = await fetch(normalized, {
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        accept: "*/*",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const diskPath = path.join(this.outputDir, safeRelativePath);
    await fs.ensureDir(path.dirname(diskPath));
    await fs.writeFile(diskPath, Buffer.from(await res.arrayBuffer()));

    const webPath = `/${safeRelativePath}`;
    this.directPathCache.set(cacheKey, webPath);
    return webPath;
  }

  async writeTextAssetAtPath(relativePath: string, content: string): Promise<string> {
    const safeRelativePath = sanitizeRelativePath(relativePath);
    const diskPath = path.join(this.outputDir, safeRelativePath);
    await fs.ensureDir(path.dirname(diskPath));
    await fs.writeFile(diskPath, content, "utf8");
    return `/${safeRelativePath}`;
  }

  private async writeTextAsset(
    content: string,
    assetUrl: string,
    category: "css" | "js",
    fallbackExt: string
  ): Promise<string> {
    const relativePath = this.buildRelativePath(assetUrl, category, fallbackExt);
    const diskPath = path.join(this.outputDir, relativePath);
    await fs.ensureDir(path.dirname(diskPath));
    await fs.writeFile(diskPath, content, "utf8");
    return relativePath;
  }

  private async writeBinaryAsset(
    buffer: Buffer,
    assetUrl: string,
    category: AssetCategory,
    contentType: string | null
  ): Promise<string> {
    const fallbackExt = this.categoryFallbackExt(category);
    const contentTypeExt = mimeTypeToExt(contentType);
    const relativePath = this.buildRelativePath(assetUrl, category, fallbackExt, contentTypeExt);
    const diskPath = path.join(this.outputDir, relativePath);
    await fs.ensureDir(path.dirname(diskPath));
    await fs.writeFile(diskPath, buffer);
    return relativePath;
  }

  private buildRelativePath(
    assetUrl: string,
    category: AssetCategory,
    fallbackExt: string,
    contentTypeExt?: string
  ): string {
    const targetDir = this.dirs[category];
    const parsed = new URL(assetUrl);
    const urlExt = path.extname(parsed.pathname).toLowerCase();
    const safeExt = pickSafeExt(urlExt, category, fallbackExt, contentTypeExt);
    const baseName = path.basename(parsed.pathname, urlExt || safeExt) || category;

    // For rspack/webpack chunks, preserve the original filename exactly
    // These are loaded dynamically by the runtime which expects exact names
    // Pattern: name.achunk.hash.js or name.chunk.hash.js
    const originalFilename = path.basename(parsed.pathname);
    const isChunk = /\.(a?chunk)\.[a-f0-9]+\.js$/i.test(originalFilename);

    let filename: string;
    if (isChunk) {
      // Preserve original chunk filename
      filename = originalFilename;
    } else {
      // For other assets, use slugified name with hash for deduplication
      const hash = crypto.createHash("sha1").update(assetUrl).digest("hex").slice(0, 10);
      filename = `${slugify(baseName)}-${hash}${safeExt}`;
    }

    const relativeDir = path.relative(this.outputDir, targetDir) || "";
    const relPath = path.join(relativeDir, filename);
    return relPath.replace(/\\+/g, "/");
  }

  private categoryFallbackExt(category: AssetCategory): string {
    if (category === "image") return ".png";
    if (category === "font") return ".woff2";
    if (category === "media") return ".bin";
    if (category === "css") return ".css";
    if (category === "js") return ".js";
    return ".bin";
  }

  private normalizeUrl(assetUrl: string): string | undefined {
    if (!assetUrl || assetUrl.startsWith("data:")) {
      return undefined;
    }
    try {
      const parsed = new URL(assetUrl);
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  private shouldDownloadUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // Allow Webflow CDN domains
      if (
        hostname === "cdn.prod.website-files.com" ||
        hostname.endsWith(".prod.website-files.com") ||
        hostname.endsWith("website-files.com") ||
        hostname === "uploads-ssl.webflow.com" ||
        hostname === "d3e54v103j8qbb.cloudfront.net"
      ) {
        return true;
      }

      // Allow webflow domains
      if (hostname.includes("webflow.com")) {
        return true;
      }

      // Allow Google Fonts domains
      if (hostname.includes("fonts.googleapis.com") || hostname.includes("fonts.gstatic.com")) {
        return true;
      }

      // Block known third-party tracking/analytics domains
      const blockedDomains = [
        "termly.io",
        "googletagmanager.com",
        "google-analytics.com",
        "facebook.net",
        "connect.facebook.net",
        "redditstatic.com",
        "analytics.tiktok.com",
        "posthog.com",
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "chatlio.com",
        "intercom.io",
        "hotjar.com",
        "mixpanel.com",
        "segment.io",
        "segment.com",
        "amplitude.com",
        "heapanalytics.com",
        "fullstory.com",
        "clarity.ms",
        "partnerstack.com",
        "taboola.com",
      ];

      for (const blocked of blockedDomains) {
        if (hostname.includes(blocked)) {
          return false;
        }
      }

      // Allow same-origin or relative URLs
      return true;
    } catch {
      return false;
    }
  }

  private matchBlacklistRule(url: string): string | null {
    if (this.blacklist.length === 0) {
      return null;
    }

    const normalizedWithoutQuery = stripQuery(url);
    for (const rule of this.blacklist) {
      if (rule.endsWith("*")) {
        const prefix = rule.slice(0, -1);
        if (url.startsWith(prefix) || normalizedWithoutQuery.startsWith(prefix)) {
          return rule;
        }
        continue;
      }

      if (url === rule || normalizedWithoutQuery === rule) {
        return rule;
      }
    }

    return null;
  }

  private logBlacklistSkip(url: string, rule: string): void {
    const key = `${rule}::${url}`;
    if (this.blacklistLogCache.has(key)) {
      return;
    }
    this.blacklistLogCache.add(key);
    log.info(`Skipping blacklisted download ${url} (rule: ${rule})`);
  }

  /**
   * Extract rspack/webpack chunk manifest and download all chunks proactively.
   * Rewrites the chunk URL function to use local paths.
   *
   * rspack pattern: r.u=e=>"new-point.achunk."+{0:"hash0",1:"hash1",...}[e]+".js"
   */
  private async extractAndDownloadChunks(js: string, jsUrl: string): Promise<string> {
    // Match rspack chunk URL pattern: r.u=e=>"prefix"+({...})[e]+".js"
    // or similar patterns like: .u=function(e){return"prefix"+{...}[e]+".js"}
    // Note: rspack wraps the manifest in parentheses: ({...})
    const chunkManifestPattern =
      /(\w+\.u\s*=\s*(?:function\s*\(\s*\w+\s*\)\s*\{?\s*return\s*|(?:\w+)\s*=>\s*))["']([^"']+)["']\s*\+\s*\(?(\{[^}]+\})\)?\s*\[\s*\w+\s*\]\s*\+\s*["']([^"']+)["']/g;

    let match: RegExpExecArray | null;
    const chunkDownloads: Promise<void>[] = [];
    const chunkUrlMap = new Map<string, string>(); // original chunk filename -> local path

    // Find all chunk manifests
    while ((match = chunkManifestPattern.exec(js)) !== null) {
      const prefix = match[2]; // e.g., "new-point.achunk."
      const manifestStr = match[3]; // e.g., {0:"hash0",1:"hash1"}
      const suffix = match[4]; // e.g., ".js"

      // Parse the manifest object to extract chunk hashes
      // Pattern: number or string key : "hash"
      const hashPattern = /(?:(\d+)|["']([^"']+)["'])\s*:\s*["']([a-f0-9]+)["']/g;
      let hashMatch: RegExpExecArray | null;

      while ((hashMatch = hashPattern.exec(manifestStr)) !== null) {
        const chunkHash = hashMatch[3];
        const chunkFilename = `${prefix}${chunkHash}${suffix}`;

        // Build absolute URL for the chunk based on the JS file's location
        try {
          const jsUrlParsed = new URL(jsUrl);
          const chunkUrl = new URL(chunkFilename, jsUrl).toString();

          // Only download if it's from the same CDN origin
          if (
            chunkUrl.includes("cdn.prod.website-files.com") ||
            chunkUrl.includes("webflow.com") ||
            new URL(chunkUrl).origin === jsUrlParsed.origin
          ) {
            // Download chunk and track its local path
            chunkDownloads.push(
              this.downloadAsset(chunkUrl, "js")
                .then((localPath) => {
                  chunkUrlMap.set(chunkFilename, localPath);
                })
                .catch((err) => {
                  log.warn(`Failed to download chunk ${chunkFilename}: ${(err as Error).message}`);
                })
            );
          }
        } catch {
          // Invalid URL, skip
        }
      }
    }

    // Wait for all chunk downloads
    if (chunkDownloads.length > 0) {
      log.info(`Downloading ${chunkDownloads.length} rspack chunks from ${new URL(jsUrl).pathname}`);
      await Promise.all(chunkDownloads);
    }

    // Note: We do NOT modify r.u (chunk URL function) because:
    // - rspack runtime loads chunks via: r.p + r.u(chunkId)
    // - r.p (public path) is dynamically computed from the script's src URL
    // - If script is at /js/main.js, r.p becomes /js/
    // - r.u returns just the filename: "new-point.achunk.{hash}.js"
    // - Final URL: /js/ + new-point.achunk.{hash}.js = /js/new-point.achunk.{hash}.js
    // So we just need to ensure chunks are saved with their original filenames in /js/

    return js;
  }

  private async rewriteCssUrls(css: string, cssUrl: string): Promise<string> {
    const matches: Array<{
      start: number;
      end: number;
      replacement: string;
    }> = [];

    const regex = /url\(([^)]+)\)/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(css)) !== null) {
      const fullMatch = match[0];
      const rawValue = match[1];
      const trimmed = rawValue.trim();
      const quote = trimmed.startsWith('"') ? '"' : trimmed.startsWith("'") ? "'" : "";
      const unquoted = quote ? trimmed.slice(1, -1) : trimmed;

      if (!unquoted || unquoted.startsWith("data:") || unquoted.startsWith("#")) {
        continue;
      }

      let absolute: string;
      try {
        absolute = new URL(unquoted, cssUrl).toString();
      } catch {
        continue;
      }

      const inferredCategory = inferCategoryFromExt(absolute);
      if (!inferredCategory) {
        continue;
      }

      const localPath = await this.downloadAsset(absolute, inferredCategory);
      const replacement = `url(${quote}${localPath}${quote})`;
      matches.push({
        start: match.index,
        end: match.index + fullMatch.length,
        replacement,
      });
    }

    if (!matches.length) {
      return css;
    }

    let result = "";
    let lastIndex = 0;
    for (const token of matches) {
      result += css.slice(lastIndex, token.start);
      result += token.replacement;
      lastIndex = token.end;
    }
    result += css.slice(lastIndex);
    return result;
  }

  private async rewriteJsUrls(js: string, jsUrl: string): Promise<string> {
    // Extract and download rspack/webpack chunks from the chunk manifest
    // Pattern: r.u=e=>"prefix"+{chunkId:"hash",...}[e]+".js"
    js = await this.extractAndDownloadChunks(js, jsUrl);

    const matches: Array<{
      start: number;
      end: number;
      replacement: string;
    }> = [];

    // Match various patterns for asset URLs in JavaScript:
    // 1. String literals: "/js/chunk.js" or '/js/chunk.js'
    // 2. Template literals: `/js/${chunk}.js`
    // 3. Dynamic imports: import("/js/chunk.js")
    // 4. Webpack chunk loading: __webpack_require__.p + "chunk.js"
    // 5. Common patterns: "chunk.abc123.js", "./chunk.js", "../chunk.js"

    // Pattern 1: String literals (single or double quotes) containing asset paths
    const stringLiteralPattern =
      /(["'])((?:\/|\.\/|\.\.\/)?[^"']*\.(?:js|mjs|cjs|css|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|otf|mp4|webm|mov))(?:\?[^"']*)?\1/g;

    // Pattern 2: Dynamic import() statements
    const importPattern = /import\s*\(\s*(["'])([^"']+)\1\s*\)/g;

    // Pattern 3: Webpack public path patterns
    const webpackPattern = /__webpack_require__\.p\s*\+\s*(["'])([^"']+)\1/g;

    let match: RegExpExecArray | null;

    // Match string literals
    while ((match = stringLiteralPattern.exec(js)) !== null) {
      const quote = match[1];
      const url = match[2];

      if (
        !url ||
        url.startsWith("data:") ||
        url.startsWith("blob:") ||
        url.startsWith("http://") ||
        url.startsWith("https://")
      ) {
        continue;
      }

      if (!isLikelyAssetPath(url)) {
        log.debug(`Skipping non-asset JS string: ${truncateForLog(url)}`);
        continue;
      }

      // Skip bare extension strings like ".js", ".css", etc. - these are file suffixes, not paths
      if (/^\.[a-z0-9]+$/i.test(url)) {
        continue;
      }

      let absolute: string;
      try {
        absolute = new URL(url, jsUrl).toString();
      } catch {
        continue;
      }

      // Only rewrite if it's an asset URL (same origin or looks like an asset)
      try {
        const jsParsed = new URL(jsUrl);
        const urlParsed = new URL(absolute);

        // Only rewrite same-origin assets or relative paths
        if (
          urlParsed.origin === jsParsed.origin ||
          url.startsWith("/") ||
          url.startsWith("./") ||
          url.startsWith("../")
        ) {
          const inferredCategory = inferCategoryFromExt(absolute) || inferCategoryFromUrl(absolute);
          if (inferredCategory) {
            const localPath = await this.downloadAsset(absolute, inferredCategory);
            const replacement = `${quote}${localPath}${quote}`;
            matches.push({
              start: match.index!,
              end: match.index! + match[0].length,
              replacement,
            });
          }
        }
      } catch {
        continue;
      }
    }

    // Match dynamic imports
    stringLiteralPattern.lastIndex = 0;
    while ((match = importPattern.exec(js)) !== null) {
      const quote = match[1];
      const url = match[2];

      if (!url || url.startsWith("data:") || url.startsWith("blob:")) {
        continue;
      }

      if (!isLikelyAssetPath(url)) {
        log.debug(`Skipping non-asset JS import: ${truncateForLog(url)}`);
        continue;
      }

      let absolute: string;
      try {
        absolute = new URL(url, jsUrl).toString();
      } catch {
        continue;
      }

      try {
        const jsParsed = new URL(jsUrl);
        const urlParsed = new URL(absolute);

        if (
          urlParsed.origin === jsParsed.origin ||
          url.startsWith("/") ||
          url.startsWith("./") ||
          url.startsWith("../")
        ) {
          const inferredCategory = inferCategoryFromExt(absolute) || inferCategoryFromUrl(absolute);
          if (inferredCategory === "js") {
            const localPath = await this.downloadAsset(absolute, "js");
            const replacement = `import(${quote}${localPath}${quote})`;
            matches.push({
              start: match.index!,
              end: match.index! + match[0].length,
              replacement,
            });
          }
        }
      } catch {
        continue;
      }
    }

    if (!matches.length) {
      return js;
    }

    // Sort matches by start position (descending) to avoid index shifting issues
    matches.sort((a, b) => b.start - a.start);

    let result = js;
    for (const token of matches) {
      result = result.slice(0, token.start) + token.replacement + result.slice(token.end);
    }

    return result;
  }
}

function inferCategoryFromUrl(url: string): AssetCategory | undefined {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) return "js";
  if ([".css"].includes(ext)) return "css";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico"].includes(ext)) return "image";
  if ([".woff2", ".woff", ".ttf", ".otf", ".eot"].includes(ext)) return "font";
  if ([".mp4", ".webm", ".mov", ".mp3", ".wav"].includes(ext)) return "media";

  // Check path patterns
  if (/\/js\//.test(url) || /\.chunk\./.test(url)) return "js";
  if (/\/css\//.test(url)) return "css";
  if (/\/images?\//.test(url)) return "image";
  if (/\/fonts?\//.test(url)) return "font";
  if (/\/media\//.test(url)) return "media";

  return undefined;
}

function inferCategoryFromExt(url: string): AssetCategory | undefined {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (FONT_EXTS.has(ext)) return "font";
  if (MEDIA_EXTS.has(ext)) return "media";
  return undefined;
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || "asset";
}

function stripQuery(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.search = "";
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function normalizeBlacklist(downloadBlacklist: string[]): string[] {
  const normalized = new Set<string>();
  for (const rule of downloadBlacklist) {
    const trimmed = rule.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.endsWith("*")) {
      const prefix = trimmed.slice(0, -1);
      try {
        const parsed = new URL(prefix);
        parsed.hash = "";
        normalized.add(`${parsed.toString()}*`);
      } catch {
        // Ignore invalid rules
      }
      continue;
    }

    try {
      const parsed = new URL(trimmed);
      parsed.hash = "";
      normalized.add(stripQuery(parsed.toString()));
    } catch {
      // Ignore invalid rules
    }
  }
  return Array.from(normalized);
}

function isLikelyAssetPath(value: string): boolean {
  if (!value || value.includes("${")) return false;

  // Restrict to clean path characters to avoid matching minified code fragments.
  // Allow optional leading /, ./, or ../ and simple path segments.
  const pattern =
    /^(?:\/|\.\/|\.\.\/)?[a-z0-9._-]+(?:\/[a-z0-9._-]+)*\.(?:js|mjs|cjs|css|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|otf|mp4|webm|mov)(?:[?#][^"']*)?$/i;
  return pattern.test(value);
}

function truncateForLog(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function sanitizeRelativePath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new Error(`Invalid relative path: ${relativePath}`);
  }
  return normalized;
}

function mimeTypeToExt(contentType: string | null): string | undefined {
  if (!contentType) return undefined;
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  if (!mime) return undefined;

  // Images
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/svg+xml") return ".svg";
  if (mime === "image/avif") return ".avif";
  if (mime === "image/x-icon" || mime === "image/vnd.microsoft.icon") return ".ico";

  // Fonts
  if (mime === "font/woff2") return ".woff2";
  if (mime === "font/woff" || mime === "application/font-woff") return ".woff";
  if (mime === "font/ttf") return ".ttf";
  if (mime === "font/otf") return ".otf";
  if (mime === "application/vnd.ms-fontobject") return ".eot";

  // Media
  if (mime === "video/mp4") return ".mp4";
  if (mime === "video/webm") return ".webm";
  if (mime === "video/quicktime") return ".mov";
  if (mime === "audio/mpeg") return ".mp3";
  if (mime === "audio/wav" || mime === "audio/x-wav") return ".wav";

  return undefined;
}

function pickSafeExt(
  urlExt: string,
  category: AssetCategory,
  fallbackExt: string,
  contentTypeExt?: string
): string {
  const ext = urlExt || "";

  if (category === "image") {
    if (ext && IMAGE_EXTS.has(ext)) return ext;
    if (contentTypeExt && IMAGE_EXTS.has(contentTypeExt)) return contentTypeExt;
    return fallbackExt;
  }

  if (category === "font") {
    if (ext && FONT_EXTS.has(ext)) return ext;
    if (contentTypeExt && FONT_EXTS.has(contentTypeExt)) return contentTypeExt;
    return fallbackExt;
  }

  if (category === "media") {
    if (ext && MEDIA_EXTS.has(ext)) return ext;
    if (contentTypeExt && MEDIA_EXTS.has(contentTypeExt)) return contentTypeExt;
    return fallbackExt;
  }

  // For other categories, prefer URL ext if present.
  return ext || contentTypeExt || fallbackExt;
}
