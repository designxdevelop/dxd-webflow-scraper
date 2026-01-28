import type { StorageAdapter, StorageConfig } from "./adapter.js";
import { LocalStorage } from "./local.js";
import { S3Storage } from "./s3.js";

let storageInstance: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (!storageInstance) {
    const config = getStorageConfig();
    storageInstance = createStorage(config);
  }
  return storageInstance;
}

function getStorageConfig(): StorageConfig {
  const s3Env = getS3Env();
  const explicitType = (process.env.STORAGE_TYPE || "") as "local" | "s3" | "";
  const inferredType = explicitType || (hasS3Config(s3Env) ? "s3" : "local");

  if (inferredType === "s3") {
    const missing = getMissingS3Env(s3Env);
    if (missing.length > 0) {
      throw new Error(`Missing S3 configuration: ${missing.join(", ")}`);
    }

    return {
      type: "s3",
      s3: {
        endpoint: s3Env.endpoint!,
        accessKeyId: s3Env.accessKeyId!,
        secretAccessKey: s3Env.secretAccessKey!,
        bucket: s3Env.bucket!,
        region: s3Env.region,
        publicUrl: s3Env.publicUrl,
        forcePathStyle: s3Env.forcePathStyle,
      },
    };
  }

  return {
    type: "local",
    localPath: process.env.LOCAL_STORAGE_PATH || "./data",
  };
}

type S3Env = {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  region: string;
  publicUrl?: string;
  forcePathStyle?: boolean;
};

function getS3Env(): S3Env {
  return {
    endpoint: process.env.S3_ENDPOINT || process.env.R2_ENDPOINT,
    accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET || process.env.R2_BUCKET,
    region: process.env.S3_REGION || process.env.R2_REGION || "auto",
    publicUrl: process.env.S3_PUBLIC_URL || process.env.R2_PUBLIC_URL,
    forcePathStyle:
      process.env.S3_FORCE_PATH_STYLE === "true" ||
      process.env.R2_FORCE_PATH_STYLE === "true",
  };
}

function hasS3Config(s3Env: S3Env): boolean {
  return Boolean(s3Env.endpoint && s3Env.accessKeyId && s3Env.secretAccessKey && s3Env.bucket);
}

function getMissingS3Env(s3Env: S3Env): string[] {
  const missing: string[] = [];
  if (!s3Env.endpoint) missing.push("S3_ENDPOINT");
  if (!s3Env.accessKeyId) missing.push("S3_ACCESS_KEY_ID");
  if (!s3Env.secretAccessKey) missing.push("S3_SECRET_ACCESS_KEY");
  if (!s3Env.bucket) missing.push("S3_BUCKET");
  return missing;
}

function createStorage(config: StorageConfig): StorageAdapter {
  if (config.type === "local") {
    return new LocalStorage(config.localPath || "./data");
  }

  if (!config.s3) {
    throw new Error("Missing S3 configuration");
  }

  return new S3Storage(config.s3);
}

export type { StorageAdapter, StorageConfig } from "./adapter.js";
export { LocalStorage } from "./local.js";
export { S3Storage } from "./s3.js";
