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
      "/code-components/cdn.example.com/components/wf-manifest.json"
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

async function assertFileExists(filePath: string): Promise<void> {
  await fs.access(filePath);
}
