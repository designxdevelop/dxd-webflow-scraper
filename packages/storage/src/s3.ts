import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import type { MoveToFinalOptions, StorageAdapter } from "./adapter.js";

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
      // R2/S3-compatible endpoints can intermittently reject SDK-calculated CRC32 on streamed bodies.
      // Prefer checksums only when the service explicitly requires them.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.tempRoot = process.env.LOCAL_TEMP_PATH || "/tmp/dxd-archiver";
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const body = typeof content === "string" ? Buffer.from(content) : content;
    await this.sendWithDiagnostics("PutObject", () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: filePath,
          Body: body,
        })
      )
    );
  }

  async writeStream(filePath: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const uploadTempDir = path.join(this.tempRoot, ".stream-uploads");
    await fsp.mkdir(uploadTempDir, { recursive: true });

    const tempFilePath = path.join(uploadTempDir, `${randomUUID()}.upload`);

    try {
      // Spool the Web stream to disk first so S3 upload has a deterministic content length.
      await pipeline(Readable.fromWeb(stream as any), fs.createWriteStream(tempFilePath));
      const stat = await fsp.stat(tempFilePath);

      await this.putObjectWithFallback(filePath, tempFilePath, stat.size);
    } finally {
      await fsp.unlink(tempFilePath).catch(() => undefined);
    }
  }

  async readFile(filePath: string): Promise<Buffer> {
    const res = await this.sendWithDiagnostics("GetObject", () =>
      this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: filePath,
        })
      )
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
          const res = await this.sendWithDiagnostics("GetObject", () =>
            this.client.send(
              new GetObjectCommand({
                Bucket: this.config.bucket,
                Key: filePath,
              })
            )
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
      const res = await this.sendWithDiagnostics("ListObjectsV2", () =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          })
        )
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

    await this.sendWithDiagnostics("DeleteObjects", () =>
      this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: {
            Objects: keys.map((Key) => ({ Key })),
            Quiet: true,
          },
        })
      )
    );
  }

  async getSize(dirPath: string): Promise<number> {
    let total = 0;
    let continuationToken: string | undefined;

    do {
      const res = await this.sendWithDiagnostics("ListObjectsV2", () =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            Prefix: dirPath,
            ContinuationToken: continuationToken,
          })
        )
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
      await this.sendWithDiagnostics("HeadObject", () =>
        this.client.send(
          new HeadObjectCommand({
            Bucket: this.config.bucket,
            Key: filePath,
          })
        )
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

  async moveToFinal(tempDir: string, id: string, options?: MoveToFinalOptions): Promise<string> {
    const finalPrefix = `archives/${id}`;
    const files = await walkLocalFiles(tempDir);
    const fileStats = await Promise.all(
      files.map(async (file) => ({ file, size: (await fsp.stat(file)).size }))
    );
    const totalBytes = fileStats.reduce((sum, entry) => sum + entry.size, 0);
    let uploadedBytes = 0;
    let filesUploaded = 0;

    await options?.onProgress?.({
      totalBytes,
      uploadedBytes,
      filesTotal: fileStats.length,
      filesUploaded,
    });

    for (const { file, size } of fileStats) {
      const relative = path.relative(tempDir, file);
      const key = `${finalPrefix}/${relative}`.replace(/\\/g, "/");
      await this.putObjectWithFallback(key, file, size);
      uploadedBytes += size;
      filesUploaded += 1;
      await options?.onProgress?.({
        totalBytes,
        uploadedBytes,
        filesTotal: fileStats.length,
        filesUploaded,
        currentFile: relative,
      });
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

  private async putObjectWithFallback(key: string, localFilePath: string, size: number): Promise<void> {
    try {
      await this.sendWithDiagnostics("PutObject", () =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
            Body: fs.createReadStream(localFilePath),
            ContentLength: size,
          })
        )
      );
    } catch (error) {
      if (!isChecksumMismatchError(error) && !isSignatureMismatchError(error)) {
        throw error;
      }

      // Fallback: upload from an in-memory buffer to avoid stream signing/checksum edge cases.
      const buffer = await fsp.readFile(localFilePath);
      await this.sendWithDiagnostics("PutObject", () =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
            Body: buffer,
            ContentLength: buffer.length,
          })
        )
      );
    }
  }

  private async sendWithDiagnostics<T>(operation: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      await logDeserializationDiagnostics(error, {
        operation,
        endpoint: this.config.endpoint,
        bucket: this.config.bucket,
      });
      throw error;
    }
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

function isChecksumMismatchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /crc32 checksum/i.test(error.message);
}

function isSignatureMismatchError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as { name?: string; Code?: string; message?: string };
  const code = maybeError.Code || maybeError.name || "";
  const message = maybeError.message || "";
  return code === "SignatureDoesNotMatch" || /signature.*does not match/i.test(message);
}

type DeserializationContext = {
  operation: string;
  endpoint: string;
  bucket: string;
};

async function logDeserializationDiagnostics(error: unknown, context: DeserializationContext): Promise<void> {
  if (!looksLikeXmlDeserializationError(error)) {
    return;
  }

  const response = getHiddenResponse(error);
  const statusCode =
    response?.statusCode ??
    response?.status ??
    (typeof response?.$metadata?.httpStatusCode === "number" ? response.$metadata.httpStatusCode : undefined);
  const headers = sanitizeHeaders(response?.headers);
  const bodySnippet = await getBodySnippet(response?.body);

  console.error("[S3Storage] XML deserialization error from S3-compatible API", {
    operation: context.operation,
    endpoint: context.endpoint,
    bucket: context.bucket,
    message: error instanceof Error ? error.message : String(error),
    statusCode,
    headers,
    bodySnippet,
  });
}

function looksLikeXmlDeserializationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /deserialization error|expected closing tag|xml/i.test(error.message);
}

function getHiddenResponse(error: unknown): any {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return (error as any).$response;
}

function sanitizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (v == null) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function getBodySnippet(body: unknown, limit = 512): Promise<string | undefined> {
  if (!body) {
    return undefined;
  }
  if (typeof body === "string") {
    return body.slice(0, limit);
  }
  if (Buffer.isBuffer(body)) {
    return body.subarray(0, limit).toString("utf8");
  }
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of body as AsyncIterable<unknown>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
        const remaining = limit - size;
        if (remaining <= 0) break;
        chunks.push(buffer.subarray(0, remaining));
        size += Math.min(buffer.length, remaining);
        if (size >= limit) break;
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch {
      return "[unavailable: failed reading response body]";
    }
  }
  return undefined;
}
