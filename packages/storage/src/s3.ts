import path from "node:path";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import type { StorageAdapter } from "./adapter.js";

type S3Config = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  publicUrl?: string;
  forcePathStyle?: boolean;
};

export class S3Storage implements StorageAdapter {
  private client: S3Client;
  private tempRoot: string;

  constructor(private config: S3Config) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? false,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.tempRoot = process.env.LOCAL_TEMP_PATH || "/tmp/dxd-archiver";
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const body = typeof content === "string" ? Buffer.from(content) : content;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: filePath,
        Body: body,
      })
    );
  }

  async readFile(filePath: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: filePath,
      })
    );

    if (!res.Body) {
      throw new Error("S3 object has no body");
    }

    const stream = res.Body as Readable;
    return streamToBuffer(stream);
  }

  readStream(filePath: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          const res = await this.client.send(
            new GetObjectCommand({
              Bucket: this.config.bucket,
              Key: filePath,
            })
          );

          if (!res.Body) {
            controller.error(new Error("S3 object has no body"));
            return;
          }

          const stream = res.Body as Readable;
          for await (const chunk of stream) {
            controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
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
    let continuationToken: string | undefined;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      const contents = res.Contents || [];
      for (const item of contents) {
        if (item.Key) keys.push(item.Key);
      }

      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    return keys;
  }

  async deleteDir(dirPath: string): Promise<void> {
    const keys = await this.listFiles(dirPath);
    if (keys.length === 0) return;

    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: {
          Objects: keys.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    );
  }

  async getSize(dirPath: string): Promise<number> {
    let total = 0;
    let continuationToken: string | undefined;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: dirPath,
          ContinuationToken: continuationToken,
        })
      );

      const contents = res.Contents || [];
      for (const item of contents) {
        total += Number(item.Size || 0);
      }

      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    return total;
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: filePath,
        })
      );
      return true;
    } catch (error) {
      if (isMissingObjectError(error)) {
        return false;
      }
      throw error;
    }
  }

  async createTempDir(id: string): Promise<string> {
    const tempPath = path.join(this.tempRoot, id);
    await fsp.mkdir(tempPath, { recursive: true });
    return tempPath;
  }

  async moveToFinal(tempDir: string, id: string): Promise<string> {
    const finalPrefix = `archives/${id}`;
    const files = await walkLocalFiles(tempDir);

    for (const file of files) {
      const relative = path.relative(tempDir, file);
      const key = `${finalPrefix}/${relative}`.replace(/\\/g, "/");
      const body = await fsp.readFile(file);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
        })
      );
    }

    await fsp.rm(tempDir, { recursive: true, force: true });
    return finalPrefix;
  }

  getPublicUrl(filePath: string): string {
    if (this.config.publicUrl) {
      return `${this.config.publicUrl.replace(/\/$/, "")}/${filePath}`;
    }
    return filePath;
  }
}

async function walkLocalFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else {
        files.push(entryPath);
      }
    }
  }

  await walk(rootDir);
  return files;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  const code = maybeError.name || maybeError.Code;
  return (
    code === "NotFound" ||
    code === "NoSuchKey" ||
    code === "NotFoundError" ||
    maybeError.$metadata?.httpStatusCode === 404
  );
}
