import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchSitemapUrls } from "./sitemap-parser.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchSitemapUrls", () => {
  it("falls back to sitemap declared in robots.txt when /sitemap.xml is missing", async () => {
    const responses = new Map<string, Response>([
      ["https://example.com/sitemap.xml", new Response("Not Found", { status: 404 })],
      [
        "https://example.com/robots.txt",
        new Response("User-agent: *\nSitemap: https://example.com/custom-sitemap.xml\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ],
      [
        "https://example.com/custom-sitemap.xml",
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
           <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
             <url><loc>https://example.com/</loc></url>
             <url><loc>https://example.com/pricing</loc></url>
           </urlset>`,
          {
            status: 200,
            headers: { "content-type": "application/xml" },
          }
        ),
      ],
    ]);

    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const response = responses.get(url);
      if (!response) {
        return new Response("Not Found", { status: 404 });
      }
      return response.clone();
    };

    const urls = await fetchSitemapUrls("https://example.com");
    assert.deepEqual(urls, ["https://example.com/", "https://example.com/pricing"]);
  });

  it("falls back to common sitemap locations when robots.txt has no sitemap", async () => {
    const responses = new Map<string, Response>([
      ["https://example.com/sitemap.xml", new Response("Not Found", { status: 404 })],
      [
        "https://example.com/robots.txt",
        new Response("User-agent: *\nDisallow:\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ],
      [
        "https://example.com/sitemap_index.xml",
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
           <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
             <sitemap><loc>https://example.com/sitemaps/pages.xml</loc></sitemap>
           </sitemapindex>`,
          {
            status: 200,
            headers: { "content-type": "application/xml" },
          }
        ),
      ],
      [
        "https://example.com/sitemaps/pages.xml",
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
           <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
             <url><loc>https://example.com/about</loc></url>
           </urlset>`,
          {
            status: 200,
            headers: { "content-type": "application/xml" },
          }
        ),
      ],
    ]);

    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const response = responses.get(url);
      if (!response) {
        return new Response("Not Found", { status: 404 });
      }
      return response.clone();
    };

    const urls = await fetchSitemapUrls("https://example.com");
    assert.deepEqual(urls, ["https://example.com/about"]);
  });
});
