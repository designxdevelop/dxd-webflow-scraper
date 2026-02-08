import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { MoveToFinalOptions, StorageAdapter, WriteStreamOptions } from "./adapter.js";

export class LocalStorage implements StorageAdapter {
  constructor(private basePath: string) {}

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, content);
  }

  async writeStream(filePath: string, stream: ReadableStream<Uint8Array>, options?: WriteStreamOptions): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });

    const totalBytesHint =
      typeof options?.totalSize === "number" && Number.isFinite(options.totalSize)
        ? Math.max(0, options.totalSize)
        : 0;
    const totalParts = 1;
    let uploadedBytes = 0;
    let lastReportedBytes = 0;
    const reportEveryBytes = 4 * 1024 * 1024;

    if (options?.onProgress) {
      await options.onProgress({
        totalBytes: totalBytesHint,
        uploadedBytes: 0,
        partNumber: 0,
        totalParts,
        currentPartBytes: 0,
      });
    }

    uploadedBytes = await writeWebStreamToFile(stream, fullPath, async (writtenBytes, chunkBytes) => {
      uploadedBytes = writtenBytes;
      if (!options?.onProgress) {
        return;
      }

      const shouldReport =
        writtenBytes === chunkBytes || writtenBytes - lastReportedBytes >= reportEveryBytes;
      if (!shouldReport) {
        return;
      }

      lastReportedBytes = writtenBytes;
      await options.onProgress({
        totalBytes: totalBytesHint > 0 ? totalBytesHint : writtenBytes,
        uploadedBytes: writtenBytes,
        partNumber: writtenBytes > 0 ? 1 : 0,
        totalParts,
        currentPartBytes: chunkBytes,
      });
    });

    if (options?.onProgress) {
      const finalTotalBytes = totalBytesHint > 0 ? totalBytesHint : uploadedBytes;
      await options.onProgress({
        totalBytes: finalTotalBytes,
        uploadedBytes,
        partNumber: uploadedBytes > 0 ? 1 : 0,
        totalParts,
        currentPartBytes: 0,
      });
    }
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

async function writeWebStreamToFile(
  stream: ReadableStream<Uint8Array>,
  destinationPath: string,
  onChunk?: (writtenBytes: number, chunkBytes: number) => void | Promise<void>
): Promise<number> {
  const writable = fs.createWriteStream(destinationPath);
  const reader = stream.getReader();
  let writtenBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value || value.byteLength === 0) {
        continue;
      }

      await writeChunk(writable, value);
      writtenBytes += value.byteLength;
      await onChunk?.(writtenBytes, value.byteLength);
    }

    await closeWritable(writable);
    return writtenBytes;
  } catch (error) {
    writable.destroy(error as Error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function writeChunk(writable: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  const canContinue = writable.write(chunk);
  if (canContinue) {
    return;
  }
  await once(writable, "drain");
}

async function closeWritable(writable: fs.WriteStream): Promise<void> {
  if (writable.destroyed) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    writable.end((error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
