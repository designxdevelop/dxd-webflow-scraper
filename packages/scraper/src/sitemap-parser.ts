import { XMLParser } from "fast-xml-parser";
import { log } from "./logger.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  allowBooleanAttributes: true,
  transformTagName: (tagName: string) => tagName.toLowerCase(),
});

const COMMON_SITEMAP_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemaps.xml",
  "/sitemap/sitemap.xml",
  "/wp-sitemap.xml",
  "/sitemap.txt",
];

export async function fetchSitemapUrls(baseUrl: string): Promise<string[]> {
  const base = new URL(baseUrl);
  const origin = `${base.protocol}//${base.host}`;
  const visited = new Set<string>();
  const urls = new Set<string>();

  await traverseSitemap(new URL("/sitemap.xml", origin).toString(), visited, urls);

  if (urls.size === 0) {
    const robotsSitemaps = await discoverSitemapsFromRobots(origin);
    for (const sitemapUrl of robotsSitemaps) {
      await traverseSitemap(sitemapUrl, visited, urls);
    }
  }

  if (urls.size === 0) {
    for (const sitemapPath of COMMON_SITEMAP_PATHS) {
      const sitemapUrl = new URL(sitemapPath, origin).toString();
      await traverseSitemap(sitemapUrl, visited, urls);
    }
  }

  const sorted = Array.from(urls.values()).sort();
  if (!sorted.length) {
    log.warn(`No URLs found in sitemap for ${baseUrl}`);
  }
  return sorted;
}

async function traverseSitemap(sitemapUrl: string, visited: Set<string>, urls: Set<string>): Promise<void> {
  if (visited.has(sitemapUrl)) return;
  visited.add(sitemapUrl);

  let text: string;
  try {
    const res = await fetch(sitemapUrl, { redirect: "follow" });
    if (!res.ok) {
      log.warn(`Failed to fetch sitemap ${sitemapUrl} (${res.status})`);
      return;
    }
    text = await res.text();
  } catch (error) {
    log.warn(`Error fetching sitemap ${sitemapUrl}: ${(error as Error).message}`);
    return;
  }

  let doc: any;
  try {
    doc = parser.parse(text);
  } catch (error) {
    const textUrls = parseTextSitemapEntries(text, sitemapUrl);
    if (textUrls.pageUrls.length || textUrls.childSitemaps.length) {
      textUrls.pageUrls.forEach((url) => urls.add(url));
      await Promise.all(
        textUrls.childSitemaps.map(async (childSitemap) => {
          await traverseSitemap(childSitemap, visited, urls);
        })
      );
      return;
    }

    log.warn(`Failed to parse sitemap ${sitemapUrl}: ${(error as Error).message}`);
    return;
  }

  const sitemapIndex = getNodeByTagName(doc, "sitemapindex");
  if (sitemapIndex) {
    const children = normalizeArray(getNodeByTagName(sitemapIndex, "sitemap"));
    await Promise.all(
      children.map(async (child) => {
        const loc = getNodeByTagName(child, "loc");
        if (typeof loc === "string") {
          await traverseSitemap(loc, visited, urls);
        }
      })
    );
    return;
  }

  const urlSet = getNodeByTagName(doc, "urlset");
  if (urlSet) {
    const entries = normalizeArray(getNodeByTagName(urlSet, "url"));
    entries.forEach((entry) => {
      const loc = getNodeByTagName(entry, "loc");
      if (typeof loc === "string") {
        const normalized = normalizePageUrl(loc);
        urls.add(normalized);
      }
    });
  }
}

async function discoverSitemapsFromRobots(origin: string): Promise<string[]> {
  const robotsUrl = new URL("/robots.txt", origin).toString();
  try {
    const res = await fetch(robotsUrl, { redirect: "follow" });
    if (!res.ok) {
      return [];
    }

    const text = await res.text();
    const discovered: string[] = [];
    const seen = new Set<string>();
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      const match = line.match(/^\s*sitemap\s*:\s*(.+)$/i);
      if (!match) {
        continue;
      }

      const raw = match[1].trim();
      if (!raw) {
        continue;
      }

      try {
        const resolved = new URL(raw, origin).toString();
        if (!seen.has(resolved)) {
          seen.add(resolved);
          discovered.push(resolved);
        }
      } catch {
        // Ignore invalid sitemap values in robots.txt.
      }
    }

    if (discovered.length) {
      log.info(`Discovered ${discovered.length} sitemap(s) from robots.txt`);
    }

    return discovered;
  } catch (error) {
    log.warn(`Error fetching robots.txt ${robotsUrl}: ${(error as Error).message}`);
    return [];
  }
}

function parseTextSitemapEntries(
  text: string,
  parentSitemapUrl: string
): { pageUrls: string[]; childSitemaps: string[] } {
  const pageUrls = new Set<string>();
  const childSitemaps = new Set<string>();

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  for (const line of lines) {
    try {
      const resolved = new URL(line, parentSitemapUrl).toString();
      if (looksLikeSitemapUrl(resolved)) {
        childSitemaps.add(resolved);
      } else {
        pageUrls.add(normalizePageUrl(resolved));
      }
    } catch {
      // Ignore invalid text entries.
    }
  }

  return {
    pageUrls: Array.from(pageUrls),
    childSitemaps: Array.from(childSitemaps),
  };
}

function looksLikeSitemapUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith(".xml") || pathname.endsWith(".txt") || pathname.includes("sitemap");
  } catch {
    return false;
  }
}

function getNodeByTagName(value: unknown, tagName: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (tagName in record) {
    return record[tagName];
  }

  const suffix = `:${tagName}`;
  for (const [key, node] of Object.entries(record)) {
    if (key.endsWith(suffix)) {
      return node;
    }
  }

  return undefined;
}

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
