import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCrawlSource } from "./crawler.js";

describe("resolveCrawlSource", () => {
  it("uses sitemap URLs when available", () => {
    const source = resolveCrawlSource(
      "https://example.com",
      ["https://example.com/", "https://example.com/pricing"],
      { sitemapOnly: true, discoverLinks: true }
    );

    assert.equal(source.usedSitemap, true);
    assert.equal(source.usedFallback, false);
    assert.deepEqual(source.seedUrls, ["https://example.com/", "https://example.com/pricing"]);
    assert.equal(source.sitemapOnly, true);
    assert.equal(source.discoverLinks, false);
  });

  it("falls back to homepage seed and enables link discovery when sitemap is empty", () => {
    const source = resolveCrawlSource("https://example.com/path?utm=1#section", [], {
      sitemapOnly: true,
      discoverLinks: false,
    });

    assert.equal(source.usedSitemap, false);
    assert.equal(source.usedFallback, true);
    assert.deepEqual(source.seedUrls, ["https://example.com/path"]);
    assert.equal(source.sitemapOnly, false);
    assert.equal(source.discoverLinks, true);
  });
});
