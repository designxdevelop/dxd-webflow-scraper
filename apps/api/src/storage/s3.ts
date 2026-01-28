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
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
    const body = typeof content === "string" ? Buffer.from(content) : content;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: path,
        Body: body,
      })
    );
  }

  async readFile(path: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: path,
      })
    );

    if (!res.Body) {
      throw new Error("S3 object has no body");
    }

    const stream = res.Body as Readable;
    return streamToBuffer(stream);
  }

  readStream(path: string): ReadableStream<Uint8Array> {
    const stream = Readable.from(this.readFile(path));
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
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

  async deleteDir(path: string): Promise<void> {
    const keys = await this.listFiles(path);
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

  async getSize(path: string): Promise<number> {
    const keys = await this.listFiles(path);
    if (keys.length === 0) return 0;

    let total = 0;
    for (const key of keys) {
      const head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        })
      );
      total += Number(head.ContentLength || 0);
    }

    return total;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: path,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async createTempDir(id: string): Promise<string> {
    return `temp/${id}`;
  }

  async moveToFinal(tempDir: string, id: string): Promise<string> {
    const finalPrefix = `archives/${id}`;
    const keys = await this.listFiles(tempDir);

    for (const key of keys) {
      const newKey = key.replace(tempDir, finalPrefix);
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.config.bucket,
          CopySource: `${this.config.bucket}/${key}`,
          Key: newKey,
        })
      );
    }

    await this.deleteDir(tempDir);
    return finalPrefix;
  }

  getPublicUrl(path: string): string {
    if (this.config.publicUrl) {
      return `${this.config.publicUrl.replace(/\/$/, "")}/${path}`;
    }
    return path;
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
