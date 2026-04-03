import pLimit from "p-limit";

export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export async function runWithConcurrencyLimit<T>(
  items: Iterable<T>,
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const limit = pLimit(Math.max(1, concurrency));
  await Promise.all(Array.from(items, (item, index) => limit(() => worker(item, index))));
}
