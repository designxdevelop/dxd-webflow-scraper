import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toParts } from "./s3.js";

async function collect(chunks: number[], partSize: number) {
  async function* source() {
    let n = 0;
    for (const size of chunks) yield new Uint8Array(size).map(() => n++ % 251);
  }
  const parts: Buffer[] = [];
  for await (const part of toParts(source(), partSize)) parts.push(part);
  return parts;
}

describe("toParts", () => {
  test("re-chunks into equal parts with a short final part, preserving bytes", async () => {
    const parts = await collect([3, 10, 1, 7, 0, 4], 8);
    assert.deepEqual(parts.map((p) => p.length), [8, 8, 8, 1]);
    const all = Buffer.concat(parts);
    assert.deepEqual([...all], Array.from({ length: 25 }, (_, i) => i % 251));
  });

  test("empty stream yields nothing", async () => {
    assert.deepEqual(await collect([], 8), []);
  });
});
