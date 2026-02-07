import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { load } from "cheerio";
import { AssetDownloader } from "./asset-downloader.js";
import { rewriteHtmlDocument } from "./url-rewriter.js";

const originalFetch = globalThis.fetch;
const createdTempDirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(createdTempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("rewriteHtmlDocument code component mirroring", () => {
  it("rewrites federation manifests to local module-relative asset paths", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "dxd-code-components-"));
    createdTempDirs.push(outputDir);

    const responses = new Map<string, Response>([
      [
        "https://cdn.example.com/components/wf-manifest.json",
        jsonResponse({
          entry: "/federation/mf-manifest.json",
        }),
      ],
      [
        "https://cdn.example.com/federation/mf-manifest.json",
        jsonResponse({
          metaData: {
            publicPath: "/federation/",
            remoteEntry: {
              path: "/chunks/",
              name: "remote.js",
            },
          },
          exposes: [
            {
              assets: {
                js: {
                  sync: [
                    "/chunks/main.js",
                    "https://cdn.example.com/chunks/vendor.js",
                    "./local.js",
                  ],
                  async: [],
                },
                css: {
                  sync: [],
                  async: ["/styles/main.css"],
                },
              },
            },
          ],
          shared: [],
          remotes: [],
        }),
      ],
      ["https://cdn.example.com/chunks/remote.js", textResponse("console.log('remote')")],
      ["https://cdn.example.com/chunks/main.js", textResponse("console.log('main')")],
      ["https://cdn.example.com/chunks/vendor.js", textResponse("console.log('vendor')")],
      ["https://cdn.example.com/federation/local.js", textResponse("console.log('local')")],
      ["https://cdn.example.com/styles/main.css", textResponse("body{}")],
    ]);

    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const response = responses.get(url);
      if (!response) {
        throw new Error(`Unexpected fetch URL in test: ${url}`);
      }
      return response.clone();
    };

    const assets = new AssetDownloader(outputDir);
    await assets.init();

    const rewritten = await rewriteHtmlDocument({
      html: `<html><body><code-island data-loader='{"tag":"FEDERATION","val":{"clientModuleUrl":"https://cdn.example.com/components/wf-manifest.json"}}'></code-island></body></html>`,
      pageUrl: "https://example.com/",
      assets,
      removeWebflowBadge: false,
    });

    const $ = load(rewritten);
    const dataLoader = $("code-island").attr("data-loader");
    assert.ok(dataLoader, "Expected rewritten data-loader attribute");

    const parsedLoader = JSON.parse(dataLoader);
    assert.equal(
      parsedLoader?.val?.clientModuleUrl,
      "./code-components/cdn.example.com/components/wf-manifest.json"
    );

    const wfManifestPath = path.join(outputDir, "code-components/cdn.example.com/components/wf-manifest.json");
    const localWfManifest = JSON.parse(await fs.readFile(wfManifestPath, "utf8"));
    assert.equal(localWfManifest.entry, "./mf-manifest.json");

    const mfManifestPath = path.join(outputDir, "code-components/cdn.example.com/components/mf-manifest.json");
    const localMfManifest = JSON.parse(await fs.readFile(mfManifestPath, "utf8"));
    assert.equal(localMfManifest?.metaData?.publicPath, "/code-components/cdn.example.com/components/");
    assert.equal(localMfManifest?.metaData?.remoteEntry?.path, "chunks/");
    assert.equal(localMfManifest?.metaData?.remoteEntry?.name, "remote.js");
    assert.deepEqual(localMfManifest.exposes[0].assets.js.sync, ["chunks/main.js", "vendor.js", "local.js"]);
    assert.deepEqual(localMfManifest.exposes[0].assets.css.async, ["styles/main.css"]);

    await assertFileExists(path.join(outputDir, "code-components/cdn.example.com/components/chunks/remote.js"));
    await assertFileExists(path.join(outputDir, "code-components/cdn.example.com/components/chunks/main.js"));
    await assertFileExists(path.join(outputDir, "code-components/cdn.example.com/components/vendor.js"));
    await assertFileExists(path.join(outputDir, "code-components/cdn.example.com/components/local.js"));
    await assertFileExists(path.join(outputDir, "code-components/cdn.example.com/components/styles/main.css"));
  });
});

describe("rewriteHtmlDocument offline path normalization", () => {
  it("rewrites local archive root paths to page-relative paths for nested pages", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "dxd-offline-paths-"));
    createdTempDirs.push(outputDir);

    const responses = new Map<string, Response>([
      [
        "https://example.com/css/main.css",
        textResponse("body{background:url('/images/from-css.png')}"),
      ],
      ["https://example.com/js/app.js", textResponse("const logo = '/images/logo.png';")],
      ["https://example.com/images/logo.png", binaryResponse("image/png")],
      ["https://example.com/images/logo@2x.png", binaryResponse("image/png")],
      ["https://example.com/images/bg.png", binaryResponse("image/png")],
      ["https://example.com/images/hero.png", binaryResponse("image/png")],
      ["https://example.com/images/from-css.png", binaryResponse("image/png")],
    ]);

    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const response = responses.get(url);
      if (!response) {
        throw new Error(`Unexpected fetch URL in test: ${url}`);
      }
      return response.clone();
    };

    const assets = new AssetDownloader(outputDir);
    await assets.init();

    const rewritten = await rewriteHtmlDocument({
      html: `
        <html><head>
          <link rel="stylesheet" href="/css/main.css" />
          <script src="/js/app.js"></script>
          <style>.hero{background-image:url('/images/hero.png')}</style>
        </head><body>
          <img src="/images/logo.png" srcset="/images/logo.png 1x, /images/logo@2x.png 2x" />
          <div style="background-image:url('/images/bg.png')"></div>
        </body></html>
      `,
      pageUrl: "https://example.com/docs/guide/",
      assets,
      removeWebflowBadge: false,
    });

    const $ = load(rewritten);
    assert.match($('link[rel="stylesheet"]').attr("href") || "", /^\.\.\/\.\.\/css\//);
    assert.match($("script[src]").attr("src") || "", /^\.\.\/\.\.\/js\//);
    assert.match($("img[src]").attr("src") || "", /^\.\.\/\.\.\/images\//);
    assert.match($("img[src]").attr("srcset") || "", /^\.\.\/\.\.\/images\//);
    assert.match($("style").text(), /\.\.\/\.\.\/images\//);
    assert.match($("div[style]").attr("style") || "", /\.\.\/\.\.\/images\//);

    const cssDir = path.join(outputDir, "css");
    const cssFiles = await fs.readdir(cssDir);
    assert.ok(cssFiles.length > 0, "Expected rewritten CSS file");
    const cssContent = await fs.readFile(path.join(cssDir, cssFiles[0]), "utf8");
    assert.match(cssContent, /\.\.\/images\//);
    assert.doesNotMatch(cssContent, /url\(['"]?\/images\//);
  });
});

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function textResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "text/plain",
    },
  });
}

function binaryResponse(contentType: string): Response {
  return new Response(new Uint8Array([0, 1, 2]), {
    status: 200,
    headers: {
      "content-type": contentType,
    },
  });
}

async function assertFileExists(filePath: string): Promise<void> {
  await fs.access(filePath);
}
