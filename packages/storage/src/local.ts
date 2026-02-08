import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MoveToFinalOptions, StorageAdapter, WriteStreamOptions } from "./adapter.js";

export class LocalStorage implements StorageAdapter {
  constructor(private basePath: string) {}

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, content);
  }

  async writeStream(filePath: string, stream: ReadableStream<Uint8Array>, _options?: WriteStreamOptions): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await pipeline(Readable.fromWeb(stream as any), fs.createWriteStream(fullPath));
    // Note: Local storage doesn't support multipart/progress - options ignored
  }

  async readFile(filePath: string): Promise<Buffer> {
    const fullPath = path.join(this.basePath, filePath);
    return fsp.readFile(fullPath);
  }

  readStream(filePath: string): ReadableStream<Uint8Array> {
    const fullPath = path.join(this.basePath, filePath);
    const nodeStream = fs.createReadStream(fullPath);
    return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
  }

  async listFiles(prefix: string): Promise<string[]> {
    const fullPath = path.join(this.basePath, prefix);
    const files: string[] = [];

    async function walk(dir: string) {
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(entryPath);
          } else {
            files.push(entryPath);
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    await walk(fullPath);
    return files.map((f) => path.relative(this.basePath, f));
  }

  async deleteDir(dirPath: string): Promise<void> {
    const fullPath = path.join(this.basePath, dirPath);
    await fsp.rm(fullPath, { recursive: true, force: true });
  }

  async getSize(dirPath: string): Promise<number> {
    const fullPath = path.join(this.basePath, dirPath);
    let totalSize = 0;

    async function walk(dir: string) {
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(entryPath);
          } else {
            const stat = await fsp.stat(entryPath);
            totalSize += stat.size;
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    await walk(fullPath);
    return totalSize;
  }

  async exists(filePath: string): Promise<boolean> {
    const fullPath = path.join(this.basePath, filePath);
    try {
      await fsp.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async createTempDir(id: string): Promise<string> {
    const tempPath = path.join(this.basePath, "temp", id);
    await fsp.mkdir(tempPath, { recursive: true });
    return tempPath;
  }

  async moveToFinal(tempDir: string, id: string, options?: MoveToFinalOptions): Promise<string> {
    const totalBytes = await this.getSize(tempDir);
    const finalPath = path.join(this.basePath, "archives", id);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    // Make finalization idempotent across retries.
    await fsp.rm(finalPath, { recursive: true, force: true });
    await fsp.rename(tempDir, finalPath);
    await options?.onProgress?.({
      totalBytes,
      uploadedBytes: totalBytes,
      filesTotal: 1,
      filesUploaded: 1,
      currentFile: "local-rename",
    });
    return `archives/${id}`;
  }

  getPublicUrl(filePath: string): string {
    return `/preview/${filePath}`;
  }
}
