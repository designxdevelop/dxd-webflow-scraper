import { load, CheerioAPI, Cheerio } from "cheerio";
import { AssetDownloader } from "./asset-downloader.js";

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
  normalizeLazyMedia($);

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
