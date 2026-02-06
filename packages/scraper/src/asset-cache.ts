import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import { log } from "./logger.js";

/**
 * B6: Content-addressable disk cache for assets across crawls.
 * Key: SHA-256 of asset URL. Value: file on disk.
 *
 * Repeat crawls skip downloading unchanged assets (Webflow core JS/CSS, fonts, etc).
 * LRU eviction based on configurable max size.
 */
export class AssetCache {
  private cacheDir: string;
  private maxSizeBytes: number;
  private hits = 0;
  private misses = 0;

  constructor(cacheDir?: string, maxSizeMB: number = 2048) {
    this.cacheDir = cacheDir || path.join(process.env.LOCAL_TEMP_PATH || "/tmp", "dxd-asset-cache");
    this.maxSizeBytes = maxSizeMB * 1024 * 1024;
  }

  async init(): Promise<void> {
    await fs.ensureDir(this.cacheDir);
  }

  private keyFor(url: string): string {
    return crypto.createHash("sha256").update(url).digest("hex");
  }

  private pathFor(key: string): string {
    // Use two-level directory structure to avoid too many files in one dir
    const prefix = key.slice(0, 2);
    return path.join(this.cacheDir, prefix, key);
  }

  /**
   * Get cached content for a URL. Returns null on cache miss.
   */
  async get(url: string): Promise<Buffer | null> {
    const key = this.keyFor(url);
    const filePath = this.pathFor(key);

    try {
      if (await fs.pathExists(filePath)) {
        this.hits++;
        // Touch the file to update mtime for LRU
        const now = new Date();
        await fs.utimes(filePath, now, now).catch(() => {});
        return await fs.readFile(filePath);
      }
    } catch {
      // Cache miss
    }

    this.misses++;
    return null;
  }

  /**
   * Get cached text content for a URL. Returns null on cache miss.
   */
  async getText(url: string): Promise<string | null> {
    const buf = await this.get(url);
    return buf ? buf.toString("utf-8") : null;
  }

  /**
   * Store content in the cache.
   */
  async put(url: string, content: Buffer | string): Promise<void> {
    const key = this.keyFor(url);
    const filePath = this.pathFor(key);

    try {
      await fs.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, content);
    } catch (error) {
      log.warn(`Failed to write to asset cache: ${(error as Error).message}`);
    }
  }

  /**
   * Evict oldest entries if cache exceeds max size.
   * Call periodically (e.g., after each crawl).
   */
  async evict(): Promise<void> {
    try {
      const entries: Array<{ path: string; mtime: number; size: number }> = [];
      let totalSize = 0;

      const prefixes = await fs.readdir(this.cacheDir).catch(() => [] as string[]);
      for (const prefix of prefixes) {
        const prefixDir = path.join(this.cacheDir, prefix);
        const stat = await fs.stat(prefixDir).catch(() => null);
        if (!stat?.isDirectory()) continue;

        const files = await fs.readdir(prefixDir).catch(() => [] as string[]);
        for (const file of files) {
          const filePath = path.join(prefixDir, file);
          const fileStat = await fs.stat(filePath).catch(() => null);
          if (fileStat?.isFile()) {
            entries.push({ path: filePath, mtime: fileStat.mtimeMs, size: fileStat.size });
            totalSize += fileStat.size;
          }
        }
      }

      if (totalSize <= this.maxSizeBytes) return;

      // Sort by mtime ascending (oldest first)
      entries.sort((a, b) => a.mtime - b.mtime);

      let removed = 0;
      while (totalSize > this.maxSizeBytes && entries.length > 0) {
        const entry = entries.shift()!;
        await fs.unlink(entry.path).catch(() => {});
        totalSize -= entry.size;
        removed++;
      }

      if (removed > 0) {
        log.info(`Asset cache evicted ${removed} entries, current size: ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
      }
    } catch (error) {
      log.warn(`Asset cache eviction failed: ${(error as Error).message}`);
    }
  }

  getStats(): { hits: number; misses: number; hitRate: string } {
    const total = this.hits + this.misses;
    const rate = total > 0 ? ((this.hits / total) * 100).toFixed(1) : "0.0";
    return { hits: this.hits, misses: this.misses, hitRate: `${rate}%` };
  }
}
