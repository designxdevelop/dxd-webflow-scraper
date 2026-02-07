import { load, CheerioAPI, Cheerio } from "cheerio";
import path from "node:path";
import { AssetDownloader } from "./asset-downloader.js";
import { log } from "./logger.js";

interface RewriteOptions {
  html: string;
  pageUrl: string;
  assets: AssetDownloader;
  removeWebflowBadge?: boolean;
}

export async function rewriteHtmlDocument(options: RewriteOptions): Promise<string> {
  const { html, pageUrl, assets, removeWebflowBadge = true } = options;
  const $ = load(html);

  if (removeWebflowBadge) {
    removeWebflowBadgeElement($);
  }
  normalizeCloudflareScripts($);
  normalizeLazyMedia($);
  await processCodeIslands($, pageUrl, assets);

  await processStylesheets($, pageUrl, assets);
  await processScripts($, pageUrl, assets);
  await processImages($, pageUrl, assets);
  await processMedia($, pageUrl, assets);
  await processIcons($, pageUrl, assets);
  await processInlineStyles($, pageUrl, assets);
  await processMetaImages($, pageUrl, assets);
  await processIframes($, pageUrl, assets);

  return $.html();
}

function removeWebflowBadgeElement($: CheerioAPI) {
  $(".w-webflow-badge").remove();
}

function normalizeLazyMedia($: CheerioAPI) {
  $("img[data-src]").each((_, el) => {
    const $el = $(el);
    if (!$el.attr("src")) {
      $el.attr("src", $el.attr("data-src"));
    }
  });

  $("img[data-srcset]").each((_, el) => {
    const $el = $(el);
    if (!$el.attr("srcset")) {
      $el.attr("srcset", $el.attr("data-srcset"));
    }
  });

  $("[data-bg]").each((_, el) => {
    const $el = $(el);
    const bg = $el.attr("data-bg");
    if (bg) {
      $el.attr("style", `${$el.attr("style") || ""};background-image:url(${bg})`);
    }
  });
}

function normalizeCloudflareScripts($: CheerioAPI) {
  $("script").each((_, el) => {
    const $el = $(el);
    const src = $el.attr("src") || "";

    if (src.includes("rocket-loader.min.js")) {
      $el.remove();
      return;
    }

    if ($el.attr("data-cfasync") !== undefined) {
      $el.removeAttr("data-cfasync");
    }

    const type = ($el.attr("type") || "").toLowerCase();
    if (type === "text/rocketscript") {
      $el.attr("type", "text/javascript");
    }
  });
}

async function processStylesheets($: CheerioAPI, pageUrl: string, assets: AssetDownloader) {
  const nodes = $('link[rel="stylesheet"], link[data-wf-page]');
  await Promise.all(
    nodes
      .map(async (_, el) => {
        const $el = $(el);
        const href = absoluteUrl($el.attr("href"), pageUrl);
        if (!href) return;
        const localPath = await assets.downloadAsset(href, "css");
        $el.attr("href", localPath);
        removeIntegrity($el);
      })
      .get()
  );

  const preloadNodes = $('link[rel="preload"][as]');
  await Promise.all(
    preloadNodes
      .map(async (_, el) => {
        const $el = $(el);
        const asType = ($el.attr("as") || "").toLowerCase();
        const href = absoluteUrl($el.attr("href"), pageUrl);
        if (!href) return;
        if (asType === "style") {
          const local = await assets.downloadAsset(href, "css");
          $el.attr("href", local);
          removeIntegrity($el);
        } else if (asType === "script") {
          const local = await assets.downloadAsset(href, "js");
          $el.attr("href", local);
          removeIntegrity($el);
        } else if (asType === "image") {
          const local = await assets.downloadAsset(href, "image");
          $el.attr("href", local);
          removeIntegrity($el);
        } else if (asType === "font") {
          const local = await assets.downloadAsset(href, "font");
          $el.attr("href", local);
          removeIntegrity($el);
        }
      })
      .get()
  );
}

async function processScripts($: CheerioAPI, pageUrl: string, assets: AssetDownloader) {
  const nodes = $("script[src]");
  await Promise.all(
    nodes
      .map(async (_, el) => {
        const $el = $(el);
        const src = absoluteUrl($el.attr("src"), pageUrl);
        if (!src) return;
        const localPath = await assets.downloadAsset(src, "js");
        $el.attr("src", localPath);
        removeIntegrity($el);
      })
      .get()
  );
}

async function processImages($: CheerioAPI, pageUrl: string, assets: AssetDownloader) {
  const images = $("img[src]");
  await Promise.all(
    images
      .map(async (_, el) => {
        const $el = $(el);
        const src = absoluteUrl($el.attr("src"), pageUrl);
        if (!src) return;
        const local = await assets.downloadAsset(src, "image");
        $el.attr("src", local);
        await rewriteSrcset($el, pageUrl, assets);
      })
      .get()
  );

  const pictureSources = $("picture source[srcset]");
  await Promise.all(
    pictureSources
      .map(async (_, el) => {
        const $el = $(el);
        await rewriteSrcset($el, pageUrl, assets);
      })
      .get()
  );
}

async function rewriteSrcset($el: Cheerio<any>, pageUrl: string, assets: AssetDownloader) {
  const srcset = $el.attr("srcset");
  if (!srcset) return;

  const entries = srcset
    .split(",")
    .map((entry: string) => entry.trim())
    .filter(Boolean);

  const rewritten: string[] = [];
  for (const entry of entries) {
    const [url, descriptor] = entry.split(/\s+/);
    const absolute = absoluteUrl(url, pageUrl);
    if (!absolute) continue;
    const local = await assets.downloadAsset(absolute, "image");
    rewritten.push(descriptor ? `${local} ${descriptor}` : local);
  }

  if (rewritten.length) {
    $el.attr("srcset", rewritten.join(", "));
  }
}

async function processMedia($: CheerioAPI, pageUrl: string, assets: AssetDownloader) {
  const mediaElements = $("video[src], audio[src]");
  await Promise.all(
    mediaElements
      .map(async (_, el) => {
        const $el = $(el);
        const src = absoluteUrl($el.attr("src"), pageUrl);
        if (!src) return;
        const local = await assets.downloadAsset(src, "media");
        $el.attr("src", local);
        if ($el.is("video")) {
          const poster = $el.attr("poster");
          if (poster) {
            const absPoster = absoluteUrl(poster, pageUrl);
            if (absPoster) {
              const posterPath = await assets.downloadAsset(absPoster, "image");
              $el.attr("poster", posterPath);
            }
          }
        }
      })
      .get()
  );

  const sourceNodes = $("video source[src], audio source[src]");
  await Promise.all(
    sourceNodes
      .map(async (_, el) => {
        const $el = $(el);
        const src = absoluteUrl($el.attr("src"), pageUrl);
        if (!src) return;
        const local = await assets.downloadAsset(src, "media");
        $el.attr("src", local);
      })
      .get()
  );
}

async function processIcons($: CheerioAPI, pageUrl: string, assets: AssetDownloader) {
  const links = $('link[rel*="icon"], link[rel="apple-touch-icon"]');
  await Promise.all(
    links
      .map(async (_, el) => {
        const $el = $(el);
        const href = absoluteUrl($el.attr("href"), pageUrl);
        if (!href) return;
        const local = await assets.downloadAsset(href, "image");
        $el.attr("href", local);
      })
      .get()
  );
}

async function processMetaImages($: CheerioAPI, pageUrl: string, assets: AssetDownloader) {
  const metas = $("meta").filter((_, el) => {
    const $el = $(el);
    const property = ($el.attr("property") || "").trim().toLowerCase();
    const name = ($el.attr("name") || "").trim().toLowerCase();
    const itemprop = ($el.attr("itemprop") || "").trim().toLowerCase();

    if (itemprop === "image") return true;

    // OpenGraph variants commonly used in the wild.
    if (property === "og:image" || property === "og:image:url" || property === "og:image:secure_url")
      return true;

    // twitter:image has a few variants (twitter:image:src is still seen).
    if (name === "twitter:image" || name === "twitter:image:src") return true;

    return false;
  });

  await Promise.all(
    metas
      .map(async (_, el) => {
        const $el = $(el);
        const content = absoluteUrl($el.attr("content"), pageUrl);
        if (!content) return;
        const local = await assets.downloadAsset(content, "image");
        $el.attr("content", local);
      })
      .get()
  );

  // Also handle legacy `link rel="image_src"` which some sites still use.
  const imageSrcLinks = $('link[rel="image_src"][href]');
  await Promise.all(
    imageSrcLinks
      .map(async (_, el) => {
        const $el = $(el);
        const href = absoluteUrl($el.attr("href"), pageUrl);
        if (!href) return;
        const local = await assets.downloadAsset(href, "image");
        $el.attr("href", local);
      })
      .get()
  );
}

async function processIframes($: CheerioAPI, pageUrl: string, assets: AssetDownloader) {
  const iframes = $("iframe[src]");
  await Promise.all(
    iframes
      .map(async (_, el) => {
        const $el = $(el);
        const src = absoluteUrl($el.attr("src"), pageUrl);
        if (!src) return;

        // Download iframe content as HTML and rewrite src to point to local copy
        // Use 'media' category for HTML content or create a new category
        // For now, treat iframe HTML as a special asset type
        try {
          const localPath = await assets.downloadAsset(src, "media");
          $el.attr("src", localPath);
        } catch (error) {
          // If we can't download the iframe content, leave the original src
          // The iframe will still try to load from the original source
        }
      })
      .get()
  );
}

async function processCodeIslands($: CheerioAPI, pageUrl: string, assets: AssetDownloader) {
  const islands = $("code-island[data-loader]");
  if (!islands.length) return;

  const moduleCache = new Map<string, string>();

  await Promise.all(
    islands
      .map(async (_, el) => {
        const $el = $(el);
        const rawLoader = $el.attr("data-loader");
        if (!rawLoader) return;

        const parsed = parseJsonAttribute(rawLoader);
        if (!isRecord(parsed) || parsed.tag !== "FEDERATION") return;

        const val = asRecord(parsed.val);
        const clientModuleUrlValue = asString(val?.clientModuleUrl);
        if (!clientModuleUrlValue || !val) return;

        const clientModuleUrl = absoluteUrl(clientModuleUrlValue, pageUrl);
        if (!clientModuleUrl) return;

        try {
          let localClientModuleUrl = moduleCache.get(clientModuleUrl);
          if (!localClientModuleUrl) {
            localClientModuleUrl = await mirrorFederatedModule(clientModuleUrl, assets);
            moduleCache.set(clientModuleUrl, localClientModuleUrl);
          }

          val.clientModuleUrl = localClientModuleUrl;
          $el.attr("data-loader", JSON.stringify(parsed));
        } catch (error) {
          log.warn(
            `Failed to mirror code component module ${clientModuleUrl}: ${(error as Error).message}`,
            clientModuleUrl
          );
        }
      })
      .get()
  );
}

async function mirrorFederatedModule(clientModuleUrl: string, assets: AssetDownloader): Promise<string> {
  const normalizedClientModuleUrl = normalizeUrlPath(clientModuleUrl);
  const { moduleBaseDir, modulePublicPath, loaderFileName } = getModulePaths(normalizedClientModuleUrl);
  const localLoaderPath = path.posix.join(moduleBaseDir, loaderFileName);

  const wfManifest = await fetchJson(normalizedClientModuleUrl);
  const entryRef = asString(wfManifest.entry) || "mf-manifest.json";
  const entryUrl = new URL(entryRef, normalizedClientModuleUrl).toString();
  const localEntryRelativePath = getLocalEntryRelativePath(
    normalizedClientModuleUrl,
    entryUrl,
    "mf-manifest.json"
  );
  const localEntryPath = path.posix.join(moduleBaseDir, localEntryRelativePath);

  const mfManifest = await fetchJson(entryUrl);
  const remotePublicPath = getFederationRemotePublicPath(mfManifest, entryUrl);
  patchFederationManifestPublicPath(mfManifest, modulePublicPath);

  const rewrittenRefs = new Map<string, string>();
  const assetRefs = collectFederationAssetRefs(mfManifest);
  for (const assetRef of assetRefs) {
    const absoluteAssetUrl = new URL(assetRef, remotePublicPath).toString();
    const { localAssetPath, manifestRef } = getLocalFederationAssetMapping(
      moduleBaseDir,
      assetRef,
      absoluteAssetUrl
    );
    rewrittenRefs.set(assetRef.trim(), manifestRef);
    try {
      await assets.downloadAssetToPath(absoluteAssetUrl, localAssetPath);
    } catch (error) {
      log.warn(
        `Failed to mirror federation asset ${absoluteAssetUrl}: ${(error as Error).message}`,
        absoluteAssetUrl
      );
    }
  }

  rewriteFederationManifestAssetRefs(mfManifest, rewrittenRefs);
  wfManifest.entry = toDotRelativePath(localEntryRelativePath);
  await assets.writeTextAssetAtPath(localLoaderPath, JSON.stringify(wfManifest));
  await assets.writeTextAssetAtPath(localEntryPath, JSON.stringify(mfManifest));
  return `/${localLoaderPath}`;
}

function collectFederationAssetRefs(manifest: Record<string, unknown>): string[] {
  const refs = new Set<string>();

  const metaData = asRecord(manifest.metaData);
  const remoteEntry = asRecord(metaData?.remoteEntry);
  const remoteEntryName = asString(remoteEntry?.name);
  const remoteEntryPath = asString(remoteEntry?.path) || "";
  if (remoteEntryName) {
    refs.add(path.posix.join(remoteEntryPath, remoteEntryName));
  }

  collectAssetRefsFromList(manifest.exposes, refs);
  collectAssetRefsFromList(manifest.shared, refs);
  collectAssetRefsFromList(manifest.remotes, refs);

  return Array.from(refs);
}

function collectAssetRefsFromList(value: unknown, refs: Set<string>) {
  if (!Array.isArray(value)) return;

  for (const item of value) {
    const itemRecord = asRecord(item);
    const assets = asRecord(itemRecord?.assets);
    if (!assets) continue;

    collectStringRefs(asRecord(assets.js)?.sync, refs);
    collectStringRefs(asRecord(assets.js)?.async, refs);
    collectStringRefs(asRecord(assets.css)?.sync, refs);
    collectStringRefs(asRecord(assets.css)?.async, refs);
  }
}

function collectStringRefs(value: unknown, refs: Set<string>) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized || normalized.startsWith("data:") || normalized.toLowerCase().startsWith("javascript:")) {
      continue;
    }
    refs.add(normalized);
  }
}

function patchFederationManifestPublicPath(manifest: Record<string, unknown>, localPublicPath: string) {
  const metaData = asRecord(manifest.metaData);
  if (metaData) {
    metaData.publicPath = localPublicPath;
  }
}

function getFederationRemotePublicPath(
  manifest: Record<string, unknown>,
  fallbackUrl: string
): string {
  const metaData = asRecord(manifest.metaData);
  const rawPublicPath = asString(metaData?.publicPath);
  if (!rawPublicPath) {
    return fallbackUrl;
  }

  try {
    const absolute = new URL(rawPublicPath, fallbackUrl).toString();
    return normalizeUrlPath(absolute);
  } catch {
    return fallbackUrl;
  }
}

function getLocalFederationAssetMapping(
  moduleBaseDir: string,
  assetRef: string,
  absoluteAssetUrl: string
): { localAssetPath: string; manifestRef: string } {
  const trimmed = assetRef.trim();
  const fallback = getUrlFileName(absoluteAssetUrl, "asset.bin");

  if (/^https?:\/\//i.test(trimmed)) {
    const manifestRef = normalizeRelativeAssetPath(getUrlFileName(trimmed, fallback), fallback);
    return {
      localAssetPath: path.posix.join(moduleBaseDir, manifestRef),
      manifestRef,
    };
  }

  const withoutPrefix = trimmed.startsWith("/")
    ? trimmed.replace(/^\/+/, "")
    : trimmed.startsWith("./")
      ? trimmed.slice(2)
      : trimmed;
  const manifestRef = normalizeRelativeAssetPath(withoutPrefix || fallback, fallback);
  return {
    localAssetPath: path.posix.join(moduleBaseDir, manifestRef),
    manifestRef,
  };
}

function rewriteFederationManifestAssetRefs(
  manifest: Record<string, unknown>,
  rewrittenRefs: Map<string, string>
) {
  rewriteAssetRefsFromList(manifest.exposes, rewrittenRefs);
  rewriteAssetRefsFromList(manifest.shared, rewrittenRefs);
  rewriteAssetRefsFromList(manifest.remotes, rewrittenRefs);

  const metaData = asRecord(manifest.metaData);
  const remoteEntry = asRecord(metaData?.remoteEntry);
  if (!remoteEntry) return;

  const remoteEntryName = asString(remoteEntry.name);
  const remoteEntryPath = asString(remoteEntry.path) || "";
  if (!remoteEntryName) return;

  const remoteEntryRef = path.posix.join(remoteEntryPath, remoteEntryName).trim();
  const rewrittenRemoteEntryRef = rewrittenRefs.get(remoteEntryRef);
  if (!rewrittenRemoteEntryRef) return;

  const normalized = normalizeRelativeAssetPath(rewrittenRemoteEntryRef, remoteEntryName);
  remoteEntry.name = path.posix.basename(normalized);
  const dirname = path.posix.dirname(normalized);
  remoteEntry.path = dirname === "." ? "" : `${dirname.replace(/\/+$/, "")}/`;
}

function rewriteAssetRefsFromList(value: unknown, rewrittenRefs: Map<string, string>) {
  if (!Array.isArray(value)) return;

  for (const item of value) {
    const itemRecord = asRecord(item);
    const assets = asRecord(itemRecord?.assets);
    if (!assets) continue;

    rewriteAssetRefsInArray(asRecord(assets.js)?.sync, rewrittenRefs);
    rewriteAssetRefsInArray(asRecord(assets.js)?.async, rewrittenRefs);
    rewriteAssetRefsInArray(asRecord(assets.css)?.sync, rewrittenRefs);
    rewriteAssetRefsInArray(asRecord(assets.css)?.async, rewrittenRefs);
  }
}

function rewriteAssetRefsInArray(value: unknown, rewrittenRefs: Map<string, string>) {
  if (!Array.isArray(value)) return;

  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "string") continue;
    const rewritten = rewrittenRefs.get(item.trim());
    if (rewritten) {
      value[i] = rewritten;
    }
  }
}

function getLocalEntryRelativePath(clientModuleUrl: string, entryUrl: string, fallbackFileName: string): string {
  try {
    const clientModuleParsed = new URL(clientModuleUrl);
    const entryParsed = new URL(entryUrl);

    if (clientModuleParsed.origin === entryParsed.origin) {
      const clientModuleDir = path.posix.dirname(safeDecodeURIComponent(clientModuleParsed.pathname));
      const entryPath = safeDecodeURIComponent(entryParsed.pathname);
      if (entryPath.startsWith(`${clientModuleDir}/`)) {
        const relative = entryPath.slice(clientModuleDir.length + 1);
        return normalizeRelativeAssetPath(relative, fallbackFileName);
      }
    }
  } catch {
    // Fallback to filename below.
  }

  return normalizeRelativeAssetPath(getUrlFileName(entryUrl, fallbackFileName), fallbackFileName);
}

function normalizeRelativeAssetPath(candidate: string, fallbackFileName: string): string {
  const normalized = path.posix.normalize(candidate).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    return fallbackFileName;
  }
  return normalized;
}

function toDotRelativePath(relativePath: string): string {
  return relativePath.startsWith("./") ? relativePath : `./${relativePath}`;
}

function getModulePaths(clientModuleUrl: string): {
  moduleBaseDir: string;
  modulePublicPath: string;
  loaderFileName: string;
} {
  const parsed = new URL(clientModuleUrl);
  const decodedPathname = safeDecodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  const loaderFileName = path.posix.basename(decodedPathname) || "wf-manifest.json";
  const moduleDir = path.posix.dirname(decodedPathname);
  const moduleBaseDir =
    moduleDir && moduleDir !== "."
      ? path.posix.join("code-components", parsed.hostname, moduleDir)
      : path.posix.join("code-components", parsed.hostname);

  const modulePublicPath = `/${moduleBaseDir.replace(/\/+$/, "")}/`;
  return { moduleBaseDir, modulePublicPath, loaderFileName };
}

function normalizeUrlPath(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = safeDecodeURIComponent(parsed.pathname);
  return parsed.toString();
}

function getUrlFileName(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const decodedPathname = safeDecodeURIComponent(parsed.pathname);
    const filename = path.posix.basename(decodedPathname);
    return filename || fallback;
  } catch {
    return fallback;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      accept: "application/json, text/plain, */*",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const text = await response.text();
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("Invalid JSON response shape");
  }
  return parsed;
}

function parseJsonAttribute(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    try {
      return JSON.parse(value.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function processInlineStyles($: CheerioAPI, pageUrl: string, assets: AssetDownloader) {
  const styleTags = $("style");
  await Promise.all(
    styleTags
      .map(async (_, el) => {
        const $el = $(el);
        const css = $el.html();
        if (!css) return;
        const rewritten = await assets.rewriteInlineCss(css, pageUrl);
        $el.text(rewritten);
      })
      .get()
  );

  const nodesWithStyle = $("[style]");
  await Promise.all(
    nodesWithStyle
      .map(async (_, el) => {
        const $el = $(el);
        const style = $el.attr("style");
        if (!style) return;
        const rewritten = await assets.rewriteInlineCss(style, pageUrl);
        $el.attr("style", rewritten);
      })
      .get()
  );
}

function removeIntegrity($el: Cheerio<any>) {
  if ($el.attr("integrity")) {
    $el.removeAttr("integrity");
  }
}

function absoluteUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("#") ||
    trimmed.toLowerCase().startsWith("javascript:")
  ) {
    return undefined;
  }
  try {
    return new URL(trimmed, pageUrl).toString();
  } catch {
    return undefined;
  }
}
