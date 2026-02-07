import type { MoveToFinalOptions, StorageAdapter } from "./adapter.js";

/**
 * R2Storage implements StorageAdapter using native Cloudflare R2 bucket bindings.
 * This adapter is Workers-compatible — no Node.js APIs are used.
 *
 * The worker service continues using S3Storage (via R2's S3-compatible endpoint).
 * Both access the same R2 bucket through different protocols.
 */
export class R2Storage implements StorageAdapter {
  constructor(private bucket: R2Bucket) {}

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const body =
      typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    await this.bucket.put(filePath, body);
  }

  async writeStream(filePath: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    // R2 accepts ReadableStream directly for uploads
    await this.bucket.put(filePath, stream);
  }

  async readFile(filePath: string): Promise<Buffer> {
    const object = await this.bucket.get(filePath);
    if (!object) {
      throw new R2NotFoundError(filePath);
    }
    const arrayBuffer = await object.arrayBuffer();
    // Workers have a Buffer global via nodejs_compat
    return Buffer.from(arrayBuffer);
  }

  readStream(filePath: string): ReadableStream<Uint8Array> {
    // Return a ReadableStream that fetches from R2 on demand
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          const object = await this.bucket.get(filePath);
          if (!object || !object.body) {
            controller.error(new R2NotFoundError(filePath));
            return;
          }

          const reader = object.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  async listFiles(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({
        prefix,
        cursor,
        limit: 1000,
      });

      for (const object of listed.objects) {
        keys.push(object.key);
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return keys;
  }

  async deleteDir(dirPath: string): Promise<void> {
    const keys = await this.listFiles(dirPath);
    if (keys.length === 0) return;

    // R2 delete supports up to 1000 keys per call
    const batchSize = 1000;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      await this.bucket.delete(batch);
    }
  }

  async getSize(dirPath: string): Promise<number> {
    let total = 0;
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({
        prefix: dirPath,
        cursor,
        limit: 1000,
      });

      for (const object of listed.objects) {
        total += object.size;
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return total;
  }

  async exists(filePath: string): Promise<boolean> {
    const head = await this.bucket.head(filePath);
    return head !== null;
  }

  async createTempDir(_id: string): Promise<string> {
    // R2 has no filesystem — temp dirs are not applicable.
    // The worker service uses S3Storage for this.
    throw new Error("R2Storage does not support createTempDir. Use S3Storage from the worker.");
  }

  async moveToFinal(_tempDir: string, _id: string, _options?: MoveToFinalOptions): Promise<string> {
    // R2 has no filesystem — file moves are not applicable.
    // The worker service uses S3Storage for this.
    throw new Error("R2Storage does not support moveToFinal. Use S3Storage from the worker.");
  }

  getPublicUrl(filePath: string): string {
    // R2 public URLs require a custom domain or public bucket access.
    // Return the key as-is; callers can prepend the public URL if configured.
    return filePath;
  }
}

class R2NotFoundError extends Error {
  readonly name = "NotFound";
  readonly $metadata = { httpStatusCode: 404 };

  constructor(key: string) {
    super(`R2 object not found: ${key}`);
  }
}
