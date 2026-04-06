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
      WORKER_SKIP_LOCK_RENEWAL: "true",
    } as NodeJS.ProcessEnv);

    assert.equal(config.crawlConcurrency, 2);
    assert.equal(config.archiveConcurrency, 3);
    assert.equal(config.lockDuration, 720000);
    assert.equal(config.stalledInterval, 60000);
    assert.equal(config.orphanGraceMs, 480000);
    assert.equal(config.reconcileIntervalMs, 30000);
    assert.equal(config.skipLockRenewal, true);
  });

  it("accepts common truthy values for skipLockRenewal", () => {
    for (const raw of ["true", "TRUE", "1", "yes", "on"]) {
      const config = getWorkerRuntimeConfig({
        WORKER_SKIP_LOCK_RENEWAL: raw,
      } as NodeJS.ProcessEnv);

      assert.equal(config.skipLockRenewal, true, `expected ${raw} to enable skipLockRenewal`);
    }
  });

  it("keeps skipLockRenewal disabled for falsey or absent values", () => {
    for (const raw of [undefined, "false", "0", "no", "off", "unexpected"]) {
      const config = getWorkerRuntimeConfig(
        raw === undefined
          ? {}
          : ({
              WORKER_SKIP_LOCK_RENEWAL: raw,
            } as NodeJS.ProcessEnv)
      );

      assert.equal(config.skipLockRenewal, false, `expected ${String(raw)} to keep skipLockRenewal disabled`);
    }
  });
});
