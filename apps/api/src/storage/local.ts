import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { StorageAdapter } from "./adapter.js";

export class LocalStorage implements StorageAdapter {
  constructor(private basePath: string) {}

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, content);
  }

  async readFile(filePath: string): Promise<Buffer> {
    const fullPath = path.join(this.basePath, filePath);
    return fsp.readFile(fullPath);
  }

  readStream(filePath: string): ReadableStream<Uint8Array> {
    const fullPath = path.join(this.basePath, filePath);
    const nodeStream = fs.createReadStream(fullPath);
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
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

  async moveToFinal(tempDir: string, id: string): Promise<string> {
    const finalPath = path.join(this.basePath, "archives", id);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    await fsp.rename(tempDir, finalPath);
    return `archives/${id}`;
  }

  getPublicUrl(filePath: string): string {
    return `/preview/${filePath}`;
  }
}
