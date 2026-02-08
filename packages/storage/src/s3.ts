import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import type { MoveToFinalOptions, StorageAdapter, MultipartUploadOptions, WriteStreamOptions, MultipartUploadProgress } from "./adapter.js";

type S3Config = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  publicUrl?: string;
  forcePathStyle?: boolean;
};

const MEBIBYTE = 1024 * 1024;
const MIN_MULTIPART_PART_SIZE_BYTES = 5 * MEBIBYTE;
const MAX_MULTIPART_PARTS = 10_000;
const DEFAULT_BUFFER_FALLBACK_MAX_BYTES = 256 * MEBIBYTE;
const DEFAULT_MULTIPART_PART_SIZE_BYTES = 16 * MEBIBYTE;
const DEFAULT_UPLOAD_PART_ATTEMPTS = 4;
const DEFAULT_UPLOAD_RETRY_BASE_DELAY_MS = 300;

export class S3Storage implements StorageAdapter {
  private client: S3Client;
  private tempRoot: string;
  private bufferFallbackMaxBytes: number;
  private multipartPartSizeBytes: number;
  private uploadPartAttempts: number;
  private uploadRetryBaseDelayMs: number;

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
    this.bufferFallbackMaxBytes = readPositiveIntEnv(
      "S3_BUFFER_FALLBACK_MAX_BYTES",
      DEFAULT_BUFFER_FALLBACK_MAX_BYTES
    );
    this.multipartPartSizeBytes = Math.max(
      MIN_MULTIPART_PART_SIZE_BYTES,
      readPositiveIntEnv("S3_MULTIPART_PART_SIZE_BYTES", DEFAULT_MULTIPART_PART_SIZE_BYTES)
    );
    this.uploadPartAttempts = readPositiveIntEnv("S3_UPLOAD_PART_ATTEMPTS", DEFAULT_UPLOAD_PART_ATTEMPTS);
    this.uploadRetryBaseDelayMs = readPositiveIntEnv(
      "S3_UPLOAD_RETRY_BASE_DELAY_MS",
      DEFAULT_UPLOAD_RETRY_BASE_DELAY_MS
    );
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const body = typeof content === "string" ? Buffer.from(content) : content;
    if (body.length === 0) {
      await this.sendWithDiagnostics("PutObject", () =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: filePath,
            Body: body,
          })
        )
      );
      return;
    }

    const uploadTempDir = path.join(this.tempRoot, ".stream-uploads");
    await fsp.mkdir(uploadTempDir, { recursive: true });

    const tempFilePath = path.join(uploadTempDir, `${randomUUID()}.upload`);
    try {
      await fsp.writeFile(tempFilePath, body);
      await this.putObjectWithFallback(filePath, tempFilePath, body.length);
    } finally {
      await fsp.unlink(tempFilePath).catch(() => undefined);
    }
  }

  async writeStream(filePath: string, stream: ReadableStream<Uint8Array>, options?: WriteStreamOptions): Promise<void> {
    const uploadTempDir = path.join(this.tempRoot, ".stream-uploads");
    await fsp.mkdir(uploadTempDir, { recursive: true });

    const tempFilePath = path.join(uploadTempDir, `${randomUUID()}.upload`);

    try {
      // Spool the Web stream to disk first so S3 upload has a deterministic content length.
      await writeWebStreamToFile(stream, tempFilePath);
      const stat = await fsp.stat(tempFilePath);

      await this.putObjectWithFallback(filePath, tempFilePath, stat.size, options);
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

  private async putObjectWithFallback(key: string, localFilePath: string, size: number, options?: MultipartUploadOptions): Promise<void> {
    try {
      if (size === 0) {
        await this.putObjectFromBuffer(key, localFilePath);
        return;
      }

      // Use multipart for all non-empty files to keep uploads retryable per-part.
      await this.putObjectMultipart(key, localFilePath, size, options);
    } catch (error) {
      if (
        (isChecksumMismatchError(error) || isSignatureMismatchError(error) || isRetryableUploadError(error)) &&
        size <= this.bufferFallbackMaxBytes
      ) {
        await this.putObjectFromBuffer(key, localFilePath);
        return;
      }
      throw error;
    }
  }

  private async putObjectFromBuffer(key: string, localFilePath: string): Promise<void> {
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

  private async putObjectMultipart(key: string, localFilePath: string, size: number, options?: MultipartUploadOptions): Promise<void> {
    const partSize = resolveMultipartPartSize(size, this.multipartPartSizeBytes);
    const totalParts = Math.ceil(size / partSize);
    let uploadId: string | undefined;
    let fileHandle: fsp.FileHandle | undefined;
    const completedParts: Array<{ ETag: string; PartNumber: number }> = [];
    let uploadedBytes = 0;

    // Report initial progress (0%)
    await options?.onProgress?.({
      totalBytes: size,
      uploadedBytes: 0,
      partNumber: 0,
      totalParts,
      currentPartBytes: 0,
    });

    try {
      const created = await this.sendWithDiagnostics("CreateMultipartUpload", () =>
        this.client.send(
          new CreateMultipartUploadCommand({
            Bucket: this.config.bucket,
            Key: key,
          })
        )
      );

      uploadId = created.UploadId;
      if (!uploadId) {
        throw new Error(`CreateMultipartUpload did not return UploadId for ${key}`);
      }

      fileHandle = await fsp.open(localFilePath, "r");
      let offset = 0;
      let partNumber = 1;

      while (offset < size) {
        const bytesToRead = Math.min(partSize, size - offset);
        const chunk = await readChunk(fileHandle, offset, bytesToRead);
        if (chunk.length === 0) {
          break;
        }

        const etag = await this.uploadMultipartPartWithRetry({
          key,
          uploadId,
          partNumber,
          chunk,
        });

        completedParts.push({
          ETag: etag,
          PartNumber: partNumber,
        });
        uploadedBytes += chunk.length;
        offset += chunk.length;

        // Report progress after each part
        await options?.onProgress?.({
          totalBytes: size,
          uploadedBytes,
          partNumber,
          totalParts,
          currentPartBytes: chunk.length,
        });

        partNumber += 1;

        // Add delay between parts to prevent TCP_OVERWINDOW
        // Skip delay for the last part
        if (offset < size && options?.partDelayMs && options.partDelayMs > 0) {
          await wait(options.partDelayMs);
        }
      }

      if (offset !== size) {
        throw new Error(`Multipart upload read ${offset} bytes but expected ${size} bytes for ${key}`);
      }

      await this.sendWithDiagnostics("CompleteMultipartUpload", () =>
        this.client.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.config.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
              Parts: completedParts,
            },
          })
        )
      );
    } catch (error) {
      if (uploadId) {
        await this.sendWithDiagnostics("AbortMultipartUpload", () =>
          this.client.send(
            new AbortMultipartUploadCommand({
              Bucket: this.config.bucket,
              Key: key,
              UploadId: uploadId,
            })
          )
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  }

  private async uploadMultipartPartWithRetry(params: {
    key: string;
    uploadId: string;
    partNumber: number;
    chunk: Buffer;
  }): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.uploadPartAttempts; attempt++) {
      try {
        const uploaded = await this.sendWithDiagnostics("UploadPart", () =>
          this.client.send(
            new UploadPartCommand({
              Bucket: this.config.bucket,
              Key: params.key,
              UploadId: params.uploadId,
              PartNumber: params.partNumber,
              Body: params.chunk,
              ContentLength: params.chunk.length,
            })
          )
        );

        if (!uploaded.ETag) {
          throw new Error(`UploadPart returned no ETag for ${params.key} part ${params.partNumber}`);
        }

        return uploaded.ETag;
      } catch (error) {
        lastError = error;
        if (!isRetryableUploadError(error) || attempt >= this.uploadPartAttempts) {
          break;
        }

        const delayMs = this.uploadRetryBaseDelayMs * Math.pow(2, attempt - 1);
        await wait(delayMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`UploadPart failed for ${params.key} part ${params.partNumber}`);
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

async function writeWebStreamToFile(
  stream: ReadableStream<Uint8Array>,
  destinationPath: string
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

      await writeChunkToFile(writable, value);
      writtenBytes += value.byteLength;
    }

    await closeFileWriteStream(writable);
    return writtenBytes;
  } catch (error) {
    writable.destroy(error as Error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function writeChunkToFile(writable: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  const canContinue = writable.write(chunk);
  if (canContinue) {
    return;
  }
  await once(writable, "drain");
}

async function closeFileWriteStream(writable: fs.WriteStream): Promise<void> {
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

function resolveMultipartPartSize(totalBytes: number, preferredPartSize: number): number {
  const minRequiredPartSize = Math.ceil(totalBytes / MAX_MULTIPART_PARTS);
  return Math.max(MIN_MULTIPART_PART_SIZE_BYTES, preferredPartSize, minRequiredPartSize);
}

async function readChunk(
  fileHandle: fsp.FileHandle,
  offset: number,
  bytesToRead: number
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
  if (bytesRead <= 0) {
    return Buffer.alloc(0);
  }
  return bytesRead === bytesToRead ? buffer : buffer.subarray(0, bytesRead);
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

function isRetryableUploadError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as {
    name?: string;
    Code?: string;
    message?: string;
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: number };
  };

  if (maybeError.$retryable) {
    return true;
  }

  const statusCode = maybeError.$metadata?.httpStatusCode;
  if (typeof statusCode === "number" && (statusCode === 408 || statusCode === 429 || statusCode >= 500)) {
    return true;
  }

  const code = (maybeError.Code || maybeError.name || "").toLowerCase();
  const message = (maybeError.message || "").toLowerCase();

  return (
    code.includes("timeout") ||
    code.includes("throttl") ||
    code.includes("slowdown") ||
    code.includes("internalerror") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("network error")
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
