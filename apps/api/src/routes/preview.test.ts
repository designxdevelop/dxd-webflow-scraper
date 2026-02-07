import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { previewRoutes } from "./preview.js";
import type { AppEnv } from "../env.js";

const PREVIEW_ROBOTS_DIRECTIVE = "noindex, nofollow, noarchive, nosnippet, noimageindex";

function createTestApp(fileContents: Record<string, Buffer>) {
  const app = new Hono<AppEnv>();
  const crawlId = "crawl-1";
  const outputPath = "output/crawl-1";

  const db = {
    query: {
      crawls: {
        findFirst: async () => ({ id: crawlId, outputPath }),
      },
    },
  };

  const storage = {
    exists: async (path: string) => path in fileContents || `${path}/index.html` in fileContents,
    readFile: async (path: string) => {
      const direct = fileContents[path];
      if (direct) return direct;
      const indexPath = `${path}/index.html`;
      const index = fileContents[indexPath];
      if (index) return index;
      throw new Error(`missing file: ${path}`);
    },
  };

  app.use("*", async (c, next) => {
    c.set("db", db as AppEnv["Variables"]["db"]);
    c.set("storage", storage as AppEnv["Variables"]["storage"]);
    await next();
  });
  app.route("/preview", previewRoutes);

  return { app, crawlId };
}

describe("preview no-index protections", () => {
  it("sets no-index headers and injects robots meta on HTML", async () => {
    const { app, crawlId } = createTestApp({
      "output/crawl-1/index.html": Buffer.from("<html><head><title>T</title></head><body>OK</body></html>"),
    });

    const res = await app.request(`/preview/${crawlId}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Robots-Tag"), PREVIEW_ROBOTS_DIRECTIVE);
    const text = await res.text();
    assert.ok(text.includes(`<meta name="robots" content="${PREVIEW_ROBOTS_DIRECTIVE}">`));
  });

  it("sets no-index headers on CSS previews", async () => {
    const { app, crawlId } = createTestApp({
      "output/crawl-1/assets/site.css": Buffer.from("body{background:url('/img/a.png')}"),
    });

    const res = await app.request(`/preview/${crawlId}/assets/site.css`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Robots-Tag"), PREVIEW_ROBOTS_DIRECTIVE);
    assert.ok(res.headers.get("Content-Type")?.includes("text/css"));
  });

  it("sets no-index headers on binary assets", async () => {
    const { app, crawlId } = createTestApp({
      "output/crawl-1/images/logo.png": Buffer.from([137, 80, 78, 71]),
    });

    const res = await app.request(`/preview/${crawlId}/images/logo.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Robots-Tag"), PREVIEW_ROBOTS_DIRECTIVE);
    assert.equal(res.headers.get("Content-Type"), "image/png");
  });

  it("serves robots.txt that disallows all crawling", async () => {
    const { app, crawlId } = createTestApp({});
    const res = await app.request(`/preview/${crawlId}/robots.txt`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Robots-Tag"), PREVIEW_ROBOTS_DIRECTIVE);
    assert.ok(res.headers.get("Content-Type")?.includes("text/plain"));
    assert.equal(await res.text(), "User-agent: *\nDisallow: /\n");
  });
});
