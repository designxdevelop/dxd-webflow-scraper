import path from "node:path";
import fs from "fs-extra";
import { BrowserContext } from "playwright";
import { AssetDownloader } from "./asset-downloader.js";
import { rewriteHtmlDocument } from "./url-rewriter.js";
import { AssetCategory, CrawlProgress, PageResult } from "./types.js";
import { log } from "./logger.js";

interface PageProcessorOptions {
  url: string;
  /** B4: Reuse a shared browser context instead of creating one per page. */
  context: BrowserContext;
  outputDir: string;
  assets: AssetDownloader;
  removeWebflowBadge?: boolean;
  signal?: AbortSignal;
  shouldAbort?: () => boolean | Promise<boolean>;
  onProgress?: (progress: Partial<CrawlProgress>) => void | Promise<void>;
}

export async function processPage(options: PageProcessorOptions): Promise<PageResult> {
  const { url, context, outputDir, assets, removeWebflowBadge = true, signal, shouldAbort } = options;

  async function assertNotCancelled(): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Crawl cancelled by request.");
    }
    if (shouldAbort && (await shouldAbort())) {
      throw new Error("Crawl cancelled by request.");
    }
  }

  await assertNotCancelled();

  // B4: Create a new page within the shared context (much cheaper than a new context)
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(90000);

  // Track successfully loaded resources (only same-origin assets)
  const requestedResources = new Set<string>();
  const resourceCategories = new Map<string, AssetCategory>();

  // Intercept network responses to capture successfully loaded resources
  page.on("response", (response) => {
    const responseUrl = response.url();
    const status = response.status();

    if (status < 200 || status >= 300) return;
    if (responseUrl.startsWith("data:") || responseUrl.startsWith("blob:") || !responseUrl.startsWith("http")) return;

    try {
      const responseParsed = new URL(responseUrl);
      const pageParsed = new URL(url);

      if (responseParsed.origin === pageParsed.origin) {
        if (isValidAssetUrl(responseUrl)) {
          const category = inferCategoryFromUrl(responseUrl);
          if (category) {
            requestedResources.add(responseUrl);
            resourceCategories.set(responseUrl, category);
          }
        }
      }
    } catch {
      // Invalid URL, skip
    }
  });

  try {
    await assertNotCancelled();

    // B5: Smarter navigation waits — use domcontentloaded first, then bonus networkidle
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      // Wait for key content selectors
      await Promise.race([
        page.waitForSelector("main, [data-wf-page], .w-nav, article, #root", { timeout: 5000 }).catch(() => {}),
        page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}),
      ]);
      // B5: Reduced post-load wait (was 2000ms)
      await page.waitForTimeout(500);
    } catch (error) {
      if ((error as Error).message.includes("Timeout")) {
        log.warn(`Navigation timeout for ${url}, falling back to load`, url);
        await page.goto(url, { waitUntil: "load", timeout: 30000 });
        await page.waitForTimeout(500);
      } else {
        throw error;
      }
    }

    await assertNotCancelled();
    // Discover and download dynamic chunks
    await triggerDynamicChunkLoading(page, url, requestedResources, resourceCategories);

    // Download all captured resources
    const downloadPromises: Promise<void>[] = [];
    for (const resourceUrl of requestedResources) {
      const category = resourceCategories.get(resourceUrl) || inferCategoryFromUrl(resourceUrl);
      if (category) {
        downloadPromises.push(
          assets
            .downloadAsset(resourceUrl, category)
            .then(() => {})
            .catch((err) => {
              log.warn(`Failed to download ${resourceUrl}: ${(err as Error).message}`, resourceUrl);
            })
        );
      }
    }

    await Promise.all(downloadPromises);

    await assertNotCancelled();
    const html = await page.content();
    const rewritten = await rewriteHtmlDocument({ html, pageUrl: url, assets, removeWebflowBadge });
    const relativePath = buildRelativeFilePath(url);
    const diskPath = path.join(outputDir, relativePath);
    await fs.ensureDir(path.dirname(diskPath));
    await fs.writeFile(diskPath, rewritten, "utf8");

    // Return both the path and original HTML for link discovery
    return { relativePath, html };
  } finally {
    await page.close();
  }
}

/**
 * Trigger dynamic chunk loading by:
 * 1. Extracting chunk URLs from webpack/rspack manifests in the page
 * 2. Hovering over interactive elements that might trigger lazy loading
 * 3. Scrolling the page to trigger viewport-based lazy loading
 */
async function triggerDynamicChunkLoading(
  page: Awaited<ReturnType<BrowserContext["newPage"]>>,
  pageUrl: string,
  requestedResources: Set<string>,
  resourceCategories: Map<string, AssetCategory>
): Promise<void> {
  const pageParsed = new URL(pageUrl);

  // Strategy 1: Extract chunk URLs from webpack/rspack runtime
  const discoveredChunks = await page.evaluate(() => {
    const chunks: string[] = [];
    const win = window as unknown as Record<string, unknown>;

    try {
      const scripts = Array.from(document.querySelectorAll("script[src]"));
      for (const script of scripts) {
        const src = script.getAttribute("src");
        if (src && /\.chunk\.[a-f0-9]+\.js/i.test(src)) {
          chunks.push(src);
        }
      }

      const links = Array.from(document.querySelectorAll('link[rel="preload"], link[rel="prefetch"]'));
      for (const link of links) {
        const href = link.getAttribute("href");
        if (href && /\.js$/i.test(href)) {
          chunks.push(href);
        }
      }

      if (typeof win.__webpack_require__ === "object" && win.__webpack_require__ !== null) {
        const wr = win.__webpack_require__ as Record<string, unknown>;
        if (typeof wr.u === "function") {
          for (let i = 0; i < 100; i++) {
            try {
              const chunkUrl = (wr.u as (id: number) => string)(i);
              if (chunkUrl && typeof chunkUrl === "string" && chunkUrl.includes(".js")) {
                chunks.push(chunkUrl);
              }
            } catch {
              // Chunk doesn't exist
            }
          }
        }
      }

      for (const key of Object.keys(win)) {
        if (key.startsWith("webpackChunk") || key.startsWith("rspackChunk")) {
          const chunkArray = win[key];
          if (Array.isArray(chunkArray)) {
            for (const chunk of chunkArray) {
              if (Array.isArray(chunk) && chunk.length > 0) {
                const ids = chunk[0];
                if (Array.isArray(ids)) {
                  for (const id of ids) {
                    if (typeof id === "string" && id.includes(".")) {
                      chunks.push(id);
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // Ignore errors during chunk discovery
    }

    return chunks;
  });

  // Strategy 2: Extract chunk URLs from inline scripts
  const inlineChunks = await page.evaluate(() => {
    const chunks: string[] = [];
    const scripts = Array.from(document.querySelectorAll("script:not([src])"));

    for (const script of scripts) {
      const content = script.textContent || "";
      const chunkMatches = content.matchAll(/["']([^"']*?(?:\.chunk\.|\.achunk\.)[a-f0-9]+\.js)["']/gi);
      for (const match of chunkMatches) {
        chunks.push(match[1]);
      }

      const jsPathMatches = content.matchAll(/["'](\/js\/[^"']+\.js)["']/gi);
      for (const match of jsPathMatches) {
        chunks.push(match[1]);
      }
    }

    return chunks;
  });

  const allChunks = [...new Set([...discoveredChunks, ...inlineChunks])];

  for (const chunk of allChunks) {
    try {
      const absoluteUrl = new URL(chunk, pageUrl).toString();
      const chunkParsed = new URL(absoluteUrl);

      if (chunkParsed.origin === pageParsed.origin && isValidAssetUrl(absoluteUrl)) {
        if (!requestedResources.has(absoluteUrl)) {
          requestedResources.add(absoluteUrl);
          resourceCategories.set(absoluteUrl, "js");
        }
      }
    } catch {
      // Invalid URL, skip
    }
  }

  // Strategy 3: Scroll the page to trigger lazy loading
  await page.evaluate(async () => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const scrollHeight = document.documentElement.scrollHeight;
    const viewportHeight = window.innerHeight;
    const steps = Math.ceil(scrollHeight / viewportHeight);

    for (let i = 0; i <= steps; i++) {
      window.scrollTo(0, i * viewportHeight);
      await delay(100);
    }

    window.scrollTo(0, 0);
  });

  // Strategy 4: Hover over interactive elements to trigger lazy imports
  await page.evaluate(async () => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const interactiveSelectors = [
      "a[href]",
      "button",
      '[role="button"]',
      "[data-component]",
      "[data-module]",
      "[onclick]",
      "[data-action]",
    ];

    const elements = document.querySelectorAll(interactiveSelectors.join(","));
    const sample = Array.from(elements).slice(0, 20);
    for (const el of sample) {
      try {
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await delay(50);
      } catch {
        // Ignore errors
      }
    }
  });

  // B5: Reduced post-scroll wait (was 1000ms)
  await page.waitForTimeout(500);
}

function isValidAssetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;

    const ext = getExtFromPathname(pathname);

    const validExts = [
      ".js", ".mjs", ".cjs", ".css",
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico",
      ".woff2", ".woff", ".ttf", ".otf", ".eot",
      ".mp4", ".webm", ".mov", ".mp3", ".wav",
    ];

    if (validExts.includes(ext)) {
      const basename = getBasename(pathname, ext);
      if (!basename || basename === "." || basename.length === 0) return false;
      return true;
    }

    if (/\/js\/[^/]+\.chunk\.[a-f0-9]+\.js$/i.test(pathname)) return true;

    if (/^\/(js|css|images?|fonts?|media|assets)\//.test(pathname) && ext && validExts.includes(ext)) {
      const basename = getBasename(pathname, ext);
      if (basename && basename !== "." && basename.length > 0) return true;
    }

    return false;
  } catch {
    return false;
  }
}

function inferCategoryFromUrl(url: string): AssetCategory | undefined {
  try {
    const ext = getExtFromPathname(new URL(url).pathname);

    if ([".js", ".mjs", ".cjs"].includes(ext)) return "js";
    if ([".css"].includes(ext)) return "css";
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico"].includes(ext)) return "image";
    if ([".woff2", ".woff", ".ttf", ".otf", ".eot"].includes(ext)) return "font";
    if ([".mp4", ".webm", ".mov", ".mp3", ".wav"].includes(ext)) return "media";

    if (/\/js\/.*\.chunk\..*\.js$/i.test(url)) return "js";
    if (/\/css\//.test(url)) return "css";
    if (/\/images?\//.test(url)) return "image";
    if (/\/fonts?\//.test(url)) return "font";
    if (/\/media\//.test(url)) return "media";

    return undefined;
  } catch {
    return undefined;
  }
}

/** Get file extension from pathname (pure string, no node:path needed in this logic) */
function getExtFromPathname(pathname: string): string {
  return path.extname(pathname).toLowerCase();
}

/** Get basename without extension */
function getBasename(pathname: string, ext: string): string {
  return path.basename(pathname, ext);
}

export function buildRelativeFilePath(pageUrl: string): string {
  const parsed = new URL(pageUrl);
  parsed.hash = "";
  parsed.search = "";
  let pathname = parsed.pathname;

  if (!pathname || pathname === "/") {
    return "index.html";
  }

  const ext = path.extname(pathname);
  if (!ext) {
    if (!pathname.endsWith("/")) {
      pathname = `${pathname}/`;
    }
    pathname = `${pathname}index.html`;
  } else if (pathname.endsWith("/")) {
    pathname = `${pathname}index.html`;
  }

  return pathname.replace(/^\//, "");
}
