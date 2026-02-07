import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { BrowserContext } from "playwright";
import { AssetDownloader } from "./asset-downloader.js";
import { detectDynamicContent, processPage } from "./page-processor.js";

const originalFetch = globalThis.fetch;
const createdTempDirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(createdTempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("detectDynamicContent", () => {
  it("flags code-island markers", () => {
    const detection = detectDynamicContent("<html><body><code-island></code-island></body></html>");
    assert.equal(detection.isDynamic, true);
    assert.deepEqual(detection.reasons, ["code-island"]);
  });
});

describe("processPage static path", () => {
  it("keeps code-island-only pages on static path", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "dxd-page-processor-"));
    createdTempDirs.push(outputDir);

    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url !== "https://example.com/") {
        throw new Error(`Unexpected fetch URL in test: ${url}`);
      }
      return new Response("<html><body><code-island></code-island></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };

    const assets = new AssetDownloader(outputDir);
    await assets.init();

    let playwrightUsed = false;
    const fakeContext = {
      async newPage() {
        playwrightUsed = true;
        throw new Error("Playwright path should not run for code-island-only pages");
      },
    } as unknown as BrowserContext;

    const result = await processPage({
      url: "https://example.com/",
      context: fakeContext,
      outputDir,
      assets,
    });

    assert.equal(playwrightUsed, false);
    assert.equal(result.static, true);
    assert.equal(result.relativePath, "index.html");

    const saved = await fs.readFile(path.join(outputDir, "index.html"), "utf8");
    assert.match(saved, /<code-island/i);
  });
});
