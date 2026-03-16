export interface MemorySnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export function captureMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

function formatMemoryBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function formatMemorySnapshot(
  label: string,
  snapshot: MemorySnapshot,
  peakRssBytes = snapshot.rssBytes,
  extra?: Record<string, string | number | boolean | null | undefined>
): string {
  const parts = [
    `rss=${formatMemoryBytes(snapshot.rssBytes)}`,
    `heapUsed=${formatMemoryBytes(snapshot.heapUsedBytes)}`,
    `external=${formatMemoryBytes(snapshot.externalBytes)}`,
    `arrayBuffers=${formatMemoryBytes(snapshot.arrayBuffersBytes)}`,
    `peakRss=${formatMemoryBytes(Math.max(snapshot.rssBytes, peakRssBytes))}`,
  ];

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      parts.push(`${key}=${value}`);
    }
  }

  return `Memory snapshot (${label}): ${parts.join(", ")}`;
}
