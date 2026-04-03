import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { AssetDownloader } from "./asset-downloader.js";
import { setLogCallback } from "./logger.js";

const originalFetch = globalThis.fetch;
const originalBinaryLimit = process.env.CRAWL_MAX_BINARY_ASSET_BYTES;
const createdTempDirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.env.CRAWL_MAX_BINARY_ASSET_BYTES = originalBinaryLimit;
  setLogCallback(null);
  await Promise.all(createdTempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("AssetDownloader", () => {
  it("streams binary assets to disk without calling arrayBuffer", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "dxd-asset-stream-"));
    createdTempDirs.push(outputDir);

    globalThis.fetch = async () => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5, 6]));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "6",
          },
        }
      );

      Object.defineProperty(response, "arrayBuffer", {
        value: async () => {
          throw new Error("arrayBuffer should not be used for binary streaming");
        },
      });

      return response;
    };

    const assets = new AssetDownloader(outputDir);
    await assets.init();

    const localPath = await assets.downloadAsset("https://example.com/image.png", "image");
    const saved = await fs.readFile(path.join(outputDir, localPath.slice(1)));
    assert.deepEqual(Array.from(saved), [1, 2, 3, 4, 5, 6]);
  });

  it("skips oversized binary assets when HEAD reports a larger content-length", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "dxd-asset-limit-"));
    createdTempDirs.push(outputDir);
    process.env.CRAWL_MAX_BINARY_ASSET_BYTES = String(4 * 1024 * 1024);

    const logs: string[] = [];
    setLogCallback((_level, message) => {
      logs.push(message);
    });

    globalThis.fetch = async (_input, init) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(10 * 1024 * 1024) },
        });
      }

      throw new Error("GET should not run for oversized assets");
    };

    const assets = new AssetDownloader(outputDir);
    await assets.init();

    const result = await assets.downloadAsset("https://example.com/hero.png", "image");
    assert.equal(result, "https://example.com/hero.png");
    assert.ok(logs.some((message) => message.includes("Skipping image asset https://example.com/hero.png")));
  });
});
