import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateCrawlRuntimePlan,
  parseContainerMemoryLimit,
  readContainerMemoryInfo,
  resolveCrawlSource,
} from "./crawler.js";

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

describe("container memory helpers", () => {
  it("parses cgroup memory limits", () => {
    assert.equal(parseContainerMemoryLimit("max\n"), null);
    assert.equal(parseContainerMemoryLimit(`${8 * 1024 * 1024 * 1024}`), 8 * 1024 * 1024 * 1024);
  });

  it("reads cgroup-v2 memory limits when available", async () => {
    const info = await readContainerMemoryInfo(async (filePath) => {
      if (filePath === "/sys/fs/cgroup/memory.max") {
        return `${12 * 1024 * 1024 * 1024}`;
      }
      throw new Error(`unexpected path ${filePath}`);
    });

    assert.equal(info.source, "cgroup-v2");
    assert.equal(info.limitBytes, 12 * 1024 * 1024 * 1024);
  });
});

describe("calculateCrawlRuntimePlan", () => {
  it("uses container-aware memory budgeting and applies an RSS safety cap", () => {
    const plan = calculateCrawlRuntimePlan({
      requestedConcurrency: 10,
      configuredMaxConcurrency: 10,
      cpuCount: 8,
      hostFreeMemoryBytes: 32 * 1024 * 1024 * 1024,
      processRssBytes: 6.8 * 1024 * 1024 * 1024,
      containerLimitBytes: 8 * 1024 * 1024 * 1024,
      memoryBufferBytes: 512 * 1024 * 1024,
      memoryBytesPerPage: 256 * 1024 * 1024,
      memoryBytesPerBrowser: 512 * 1024 * 1024,
      pagesPerBrowser: 4,
      disableResourceChecks: false,
      overrideConcurrency: 0,
      overrideBrowsers: 0,
      rssSafetyThresholdPercent: 0.85,
    });

    assert.equal(plan.memorySource, "container");
    assert.equal(plan.rssSafetyCapApplied, true);
    assert.ok(plan.effectiveConcurrency < 10);
    assert.ok(plan.numBrowsers >= 1);
  });
});
