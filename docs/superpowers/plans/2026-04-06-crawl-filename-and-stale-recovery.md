# Crawl Filename And Stale Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `ENAMETOOLONG` worker crashes from oversized asset filenames and reduce stale crawl recovery to a 10 minute window without reclaiming healthy long-running jobs.

**Architecture:** Keep the existing crawl/archive queue flow intact. Make asset filenames safe inside `packages/scraper` by bounding only the slugified basename portion for non-chunk assets, then move worker runtime defaults into a small pure helper in `services/worker` so lock duration, orphan grace, and lock renewal behavior can be tested without importing the heavy processor module.

**Tech Stack:** Bun, TypeScript, Node `node:test`, BullMQ, existing monorepo `bun run test` / `bun run verify` scripts

---

### Task 1: Bound Generated Asset Filenames In `packages/scraper`

**Files:**
- Modify: `packages/scraper/src/asset-downloader.ts`
- Modify: `packages/scraper/src/asset-downloader.test.ts`

- [ ] **Step 1: Write the failing long-filename regression test**

Add this test to `packages/scraper/src/asset-downloader.test.ts` under the existing `describe("AssetDownloader", ...)` block:

```ts
it("truncates oversized asset basenames before writing to disk", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "dxd-asset-long-name-"));
  createdTempDirs.push(outputDir);

  const longBaseName = "hero-".repeat(80);
  globalThis.fetch = async () =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        "content-type": "image/webp",
        "content-length": "3",
      },
    });

  const assets = new AssetDownloader(outputDir);
  await assets.init();

  const localPath = await assets.downloadAsset(`https://example.com/images/${longBaseName}.webp`, "image");
  const filename = path.basename(localPath);

  assert.ok(filename.length <= 200, `expected filename <= 200 chars, got ${filename.length}`);
  assert.match(filename, /-[a-f0-9]{10}\.webp$/);

  const saved = await fs.readFile(path.join(outputDir, localPath.slice(1)));
  assert.deepEqual(Array.from(saved), [1, 2, 3]);
});
```

- [ ] **Step 2: Run the scraper test to verify it fails for the right reason**

Run:

```bash
bun test packages/scraper/src/asset-downloader.test.ts
```

Expected:

- the new test fails because the generated filename is longer than the asserted safe limit, or because the file write still throws for an oversized basename
- the existing two tests still pass

- [ ] **Step 3: Implement bounded non-chunk asset filenames**

In `packages/scraper/src/asset-downloader.ts`, add a conservative filename limit constant and helper near the existing `slugify()` helper, then use it inside `buildRelativePath()` for non-chunk assets.

Use this implementation shape:

```ts
const MAX_GENERATED_ASSET_FILENAME_LENGTH = 200;

function buildBoundedAssetFilename(baseName: string, hash: string, ext: string): string {
  const slug = slugify(baseName);
  const reservedLength = 1 + hash.length + ext.length;
  const maxBaseLength = Math.max(1, MAX_GENERATED_ASSET_FILENAME_LENGTH - reservedLength);
  const boundedBase = slug.slice(0, maxBaseLength).replace(/-+$/g, "") || "asset";
  return `${boundedBase}-${hash}${ext}`;
}
```

Then change the non-chunk branch inside `buildRelativePath()` from:

```ts
const hash = crypto.createHash("sha1").update(assetUrl).digest("hex").slice(0, 10);
filename = `${slugify(baseName)}-${hash}${safeExt}`;
```

to:

```ts
const hash = crypto.createHash("sha1").update(assetUrl).digest("hex").slice(0, 10);
filename = buildBoundedAssetFilename(baseName, hash, safeExt);
```

Do not change the chunk branch:

```ts
if (isChunk) {
  filename = originalFilename;
}
```

- [ ] **Step 4: Re-run the scraper test to verify the new regression passes**

Run:

```bash
bun test packages/scraper/src/asset-downloader.test.ts
```

Expected:

- all tests in `asset-downloader.test.ts` pass
- the new test proves oversized basenames are truncated to a safe length

- [ ] **Step 5: Add a chunk-name safety regression after the fix is green**

Add this second test to `packages/scraper/src/asset-downloader.test.ts`:

```ts
it("preserves chunk filenames exactly", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "dxd-asset-chunk-name-"));
  createdTempDirs.push(outputDir);

  globalThis.fetch = async () =>
    new Response("console.log('chunk');", {
      status: 200,
      headers: {
        "content-type": "application/javascript",
        "content-length": "21",
      },
    });

  const assets = new AssetDownloader(outputDir);
  await assets.init();

  const localPath = await assets.downloadAsset("https://example.com/js/runtime.achunk.abcdef123456.js", "js");
  assert.equal(localPath, "/js/runtime.achunk.abcdef123456.js");
});
```

- [ ] **Step 6: Re-run the scraper test file after the chunk regression is added**

Run:

```bash
bun test packages/scraper/src/asset-downloader.test.ts
```

Expected:

- all four tests in `asset-downloader.test.ts` pass

- [ ] **Step 7: Commit the scraper change**

Run:

```bash
git add packages/scraper/src/asset-downloader.ts packages/scraper/src/asset-downloader.test.ts
git commit -m "fix: bound generated asset filenames"
```

Expected:

- one commit containing only the scraper filename fix and its regression tests

### Task 2: Extract Testable Worker Runtime Config And Shorten Stale Recovery Defaults

**Files:**
- Create: `services/worker/src/worker-config.ts`
- Create: `services/worker/src/worker-config.test.ts`
- Modify: `services/worker/src/processor.ts`

- [ ] **Step 1: Write the failing worker runtime config tests**

Create `services/worker/src/worker-config.test.ts` with this content:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getWorkerRuntimeConfig } from "./worker-config.js";

describe("getWorkerRuntimeConfig", () => {
  it("uses 10 minute stale-recovery defaults and keeps lock renewal enabled", () => {
    const config = getWorkerRuntimeConfig({});

    assert.equal(config.crawlConcurrency, 1);
    assert.equal(config.archiveConcurrency, 1);
    assert.equal(config.lockDuration, 10 * 60 * 1000);
    assert.equal(config.stalledInterval, 120000);
    assert.equal(config.orphanGraceMs, 10 * 60 * 1000);
    assert.equal(config.reconcileIntervalMs, 120000);
    assert.equal(config.skipLockRenewal, false);
  });

  it("respects positive environment overrides", () => {
    const config = getWorkerRuntimeConfig({
      WORKER_CRAWL_CONCURRENCY: "2",
      WORKER_ARCHIVE_CONCURRENCY: "3",
      WORKER_LOCK_DURATION_MS: "720000",
      WORKER_STALLED_INTERVAL_MS: "60000",
      ORPHAN_CRAWL_GRACE_MS: "480000",
      ORPHAN_CRAWL_RECONCILE_INTERVAL_MS: "30000",
    } as NodeJS.ProcessEnv);

    assert.equal(config.crawlConcurrency, 2);
    assert.equal(config.archiveConcurrency, 3);
    assert.equal(config.lockDuration, 720000);
    assert.equal(config.stalledInterval, 60000);
    assert.equal(config.orphanGraceMs, 480000);
    assert.equal(config.reconcileIntervalMs, 30000);
    assert.equal(config.skipLockRenewal, false);
  });
});
```

- [ ] **Step 2: Run the worker config test to verify it fails because the helper does not exist yet**

Run:

```bash
bun test services/worker/src/worker-config.test.ts
```

Expected:

- test run fails with a module resolution or export error for `./worker-config.js`

- [ ] **Step 3: Implement the pure worker runtime config helper**

Create `services/worker/src/worker-config.ts` with this content:

```ts
export type WorkerRuntimeConfig = {
  crawlConcurrency: number;
  archiveConcurrency: number;
  lockDuration: number;
  stalledInterval: number;
  orphanGraceMs: number;
  reconcileIntervalMs: number;
  skipLockRenewal: boolean;
};

function readPositiveIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function getWorkerRuntimeConfig(env: NodeJS.ProcessEnv = process.env): WorkerRuntimeConfig {
  return {
    crawlConcurrency: readPositiveIntEnv(env, "WORKER_CRAWL_CONCURRENCY", 1),
    archiveConcurrency: readPositiveIntEnv(env, "WORKER_ARCHIVE_CONCURRENCY", 1),
    lockDuration: readPositiveIntEnv(env, "WORKER_LOCK_DURATION_MS", 10 * 60 * 1000),
    stalledInterval: readPositiveIntEnv(env, "WORKER_STALLED_INTERVAL_MS", 120000),
    orphanGraceMs: readPositiveIntEnv(env, "ORPHAN_CRAWL_GRACE_MS", 10 * 60 * 1000),
    reconcileIntervalMs: readPositiveIntEnv(env, "ORPHAN_CRAWL_RECONCILE_INTERVAL_MS", 120000),
    skipLockRenewal: false,
  };
}
```

- [ ] **Step 4: Re-run the worker config test to verify the helper passes**

Run:

```bash
bun test services/worker/src/worker-config.test.ts
```

Expected:

- both worker config tests pass

- [ ] **Step 5: Wire `processor.ts` to use the shared runtime config helper**

Update `services/worker/src/processor.ts`:

1. Add the import:

```ts
import { getWorkerRuntimeConfig } from "./worker-config.js";
```

2. Change `reconcileOrphanedCrawls()` from:

```ts
async function reconcileOrphanedCrawls(): Promise<void> {
  const orphanGraceMs = parsePositiveIntEnv("ORPHAN_CRAWL_GRACE_MS", 5 * 60 * 1000);
```

to:

```ts
async function reconcileOrphanedCrawls(orphanGraceMs = getWorkerRuntimeConfig().orphanGraceMs): Promise<void> {
```

3. Change `startWorker()` to read one config object up front:

```ts
export function startWorker() {
  const config = getWorkerRuntimeConfig();
```

4. Replace the inline env reads and options with the shared config:

```ts
const crawlWorker = new Worker<CrawlJobData>("crawl-jobs", processCrawlJob, {
  connection: workerConnection,
  concurrency: config.crawlConcurrency,
  lockDuration: config.lockDuration,
  stalledInterval: config.stalledInterval,
  maxStalledCount: 0,
  skipLockRenewal: config.skipLockRenewal,
});

const archiveWorker = new Worker<ArchiveJobData>("archive-jobs", processArchiveJob, {
  connection: workerConnection,
  concurrency: config.archiveConcurrency,
  lockDuration: config.lockDuration,
  stalledInterval: config.stalledInterval,
  maxStalledCount: 0,
  skipLockRenewal: config.skipLockRenewal,
});
```

5. Use the same config for reconciliation:

```ts
void reconcileOrphanedCrawls(config.orphanGraceMs).catch((error) => {
  console.error("[Worker] Failed to reconcile orphaned crawls:", error);
});

const reconcileTimer = setInterval(() => {
  void reconcileOrphanedCrawls(config.orphanGraceMs).catch((error) => {
    console.error("[Worker] Failed to reconcile orphaned crawls:", error);
  });
}, config.reconcileIntervalMs);
```

6. Update the startup log to reflect the config object:

```ts
console.log(
  `[Worker] Started crawl worker (concurrency=${config.crawlConcurrency}) and archive worker (concurrency=${config.archiveConcurrency}, lockDuration=${config.lockDuration}ms)`
);
```

Leave the existing local `parsePositiveIntEnv()` helper in place for the other processor-only env reads used by crawl and archive execution.

- [ ] **Step 6: Re-run the worker config test after the processor wiring change**

Run:

```bash
bun test services/worker/src/worker-config.test.ts
```

Expected:

- the worker config test still passes after the processor import/use changes

- [ ] **Step 7: Commit the worker runtime config change**

Run:

```bash
git add services/worker/src/worker-config.ts services/worker/src/worker-config.test.ts services/worker/src/processor.ts
git commit -m "fix: recover stale crawls faster"
```

Expected:

- one commit containing the worker runtime config helper, tests, and processor wiring

### Task 3: Include Worker Tests In Repo Verification And Run Final Checks

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update the root test script so worker tests run under `bun run test`**

Change the root `package.json` test script from:

```json
"test": "bun test apps/api/src apps/web/src/lib packages/scraper/src"
```

to:

```json
"test": "bun test apps/api/src apps/web/src/lib packages/scraper/src services/worker/src"
```

- [ ] **Step 2: Run the two targeted regression suites together**

Run:

```bash
bun test packages/scraper/src/asset-downloader.test.ts services/worker/src/worker-config.test.ts
```

Expected:

- both targeted test files pass

- [ ] **Step 3: Run the repo test script**

Run:

```bash
bun run test
```

Expected:

- existing repo tests still pass
- the new worker config test is included in the run

- [ ] **Step 4: Run the repo verification command**

Run:

```bash
bun run verify
```

Expected:

- lint/type checks pass
- all tests pass

- [ ] **Step 5: Commit the verification wiring**

Run:

```bash
git add package.json
git commit -m "test: include worker coverage in verify"
```

Expected:

- one small commit containing only the root test script update
