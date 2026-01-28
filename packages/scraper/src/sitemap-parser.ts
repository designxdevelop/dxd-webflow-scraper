import { XMLParser } from "fast-xml-parser";
import { log } from "./logger.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  allowBooleanAttributes: true,
  transformTagName: (tagName: string) => tagName.toLowerCase(),
});

export async function fetchSitemapUrls(baseUrl: string): Promise<string[]> {
  const base = new URL(baseUrl);
  const sitemapUrl = new URL("/sitemap.xml", `${base.protocol}//${base.host}`).toString();
  const visited = new Set<string>();
  const urls = new Set<string>();

  await traverseSitemap(sitemapUrl, visited, urls);

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
    log.warn(`Failed to parse sitemap ${sitemapUrl}: ${(error as Error).message}`);
    return;
  }

  if (doc.sitemapindex) {
    const children = normalizeArray(doc.sitemapindex.sitemap);
    await Promise.all(
      children.map(async (child) => {
        if (child.loc) {
          await traverseSitemap(child.loc, visited, urls);
        }
      })
    );
    return;
  }

  if (doc.urlset) {
    const entries = normalizeArray(doc.urlset.url);
    entries.forEach((entry) => {
      if (entry.loc) {
        const normalized = normalizePageUrl(entry.loc);
        urls.add(normalized);
      }
    });
  }
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
