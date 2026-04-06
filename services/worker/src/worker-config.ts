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

function readTruthyEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (!raw) {
    return false;
  }

  switch (raw.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

export function getWorkerRuntimeConfig(env: NodeJS.ProcessEnv = process.env): WorkerRuntimeConfig {
  return {
    crawlConcurrency: readPositiveIntEnv(env, "WORKER_CRAWL_CONCURRENCY", 1),
    archiveConcurrency: readPositiveIntEnv(env, "WORKER_ARCHIVE_CONCURRENCY", 1),
    lockDuration: readPositiveIntEnv(env, "WORKER_LOCK_DURATION_MS", 10 * 60 * 1000),
    stalledInterval: readPositiveIntEnv(env, "WORKER_STALLED_INTERVAL_MS", 120000),
    orphanGraceMs: readPositiveIntEnv(env, "ORPHAN_CRAWL_GRACE_MS", 10 * 60 * 1000),
    reconcileIntervalMs: readPositiveIntEnv(env, "ORPHAN_CRAWL_RECONCILE_INTERVAL_MS", 120000),
    skipLockRenewal: readTruthyEnv(env, "WORKER_SKIP_LOCK_RENEWAL"),
  };
}
