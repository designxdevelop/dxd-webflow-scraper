import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Browser, BrowserContext } from "playwright";
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
    const fakeBrowser = {
      async newContext() {
        playwrightUsed = true;
        throw new Error("Playwright path should not run for code-island-only pages");
      },
    } as unknown as Browser;

    const result = await processPage({
      url: "https://example.com/",
      browser: fakeBrowser,
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

describe("processPage dynamic path", () => {
  it("creates and closes a fresh browser context for each dynamic page", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "dxd-page-processor-"));
    createdTempDirs.push(outputDir);

    globalThis.fetch = async (): Promise<Response> =>
      new Response("<html><body><script>window.__webpack_require__ = {};</script></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });

    const assets = new AssetDownloader(outputDir);
    await assets.init();

    let contextCreated = 0;
    let contextClosed = 0;
    let pageClosed = 0;

    const fakePage = {
      setDefaultNavigationTimeout() {},
      setDefaultTimeout() {},
      on() {},
      removeListener() {},
      async goto() {},
      async waitForSelector() {},
      async waitForLoadState() {},
      async waitForTimeout() {},
      async evaluate() {
        return [];
      },
      async content() {
        return "<html><body><main>dynamic</main></body></html>";
      },
      async close() {
        pageClosed += 1;
      },
    };

    const fakeContext = {
      async newPage() {
        return fakePage;
      },
      async close() {
        contextClosed += 1;
      },
    } as unknown as BrowserContext;

    const fakeBrowser = {
      async newContext() {
        contextCreated += 1;
        return fakeContext;
      },
    } as unknown as Browser;

    const result = await processPage({
      url: "https://example.com/dynamic",
      browser: fakeBrowser,
      outputDir,
      assets,
    });

    assert.equal(result.static, false);
    assert.equal(contextCreated, 1);
    assert.equal(contextClosed, 1);
    assert.equal(pageClosed, 1);
  });

  it("closes the context if creating a page fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "dxd-page-processor-"));
    createdTempDirs.push(outputDir);

    globalThis.fetch = async (): Promise<Response> =>
      new Response("<html><body><script>window.__webpack_require__ = {};</script></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });

    const assets = new AssetDownloader(outputDir);
    await assets.init();

    let contextClosed = 0;

    const fakeContext = {
      async newPage() {
        throw new Error("newPage boom");
      },
      async close() {
        contextClosed += 1;
      },
    } as unknown as BrowserContext;

    const fakeBrowser = {
      async newContext() {
        return fakeContext;
      },
    } as unknown as Browser;

    await assert.rejects(
      processPage({
        url: "https://example.com/dynamic",
        browser: fakeBrowser,
        outputDir,
        assets,
      }),
      /newPage boom/
    );

    assert.equal(contextClosed, 1);
  });
});
