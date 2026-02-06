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
  const inferredType = resolveStorageType(s3Env);

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

function resolveStorageType(s3Env: S3Env): "local" | "s3" {
  const rawType = (process.env.STORAGE_TYPE || "").trim().toLowerCase();
  const hasS3 = hasS3Config(s3Env);

  if (rawType === "s3" || rawType === "r2") {
    return "s3";
  }

  if (rawType === "auto" || rawType === "") {
    return hasS3 ? "s3" : "local";
  }

  if (rawType === "local") {
    if (hasS3 && process.env.FORCE_LOCAL_STORAGE !== "true") {
      console.warn(
        "[storage] STORAGE_TYPE=local but S3/R2 config is present. Using S3/R2. Set FORCE_LOCAL_STORAGE=true to force local storage."
      );
      return "s3";
    }

    return "local";
  }

  console.warn(
    `[storage] Unsupported STORAGE_TYPE=\"${process.env.STORAGE_TYPE}\". Falling back to ${hasS3 ? "s3" : "local"}.`
  );
  return hasS3 ? "s3" : "local";
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
  const r2Env: S3Env = {
    endpoint: process.env.R2_ENDPOINT,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    region: process.env.R2_REGION || "auto",
    publicUrl: process.env.R2_PUBLIC_URL,
    forcePathStyle: process.env.R2_FORCE_PATH_STYLE === "true",
  };

  const s3Env: S3Env = {
    endpoint: process.env.S3_ENDPOINT,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION || "auto",
    publicUrl: process.env.S3_PUBLIC_URL,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  };

  if (hasS3Config(r2Env)) {
    if (hasAnyS3Env(s3Env)) {
      console.warn(
        "[storage] Both R2_* and S3_* env vars are set. Using R2_* values because R2 is fully configured."
      );
    }
    return r2Env;
  }

  if (hasS3Config(s3Env)) {
    return s3Env;
  }

  if (hasAnyS3Env(r2Env) && hasAnyS3Env(s3Env)) {
    console.warn(
      "[storage] Partial R2_* and S3_* env vars detected. Falling back to merged env resolution."
    );
  }

  return {
    endpoint: process.env.R2_ENDPOINT || process.env.S3_ENDPOINT,
    accessKeyId: process.env.R2_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET || process.env.S3_BUCKET,
    region: process.env.R2_REGION || process.env.S3_REGION || "auto",
    publicUrl: process.env.R2_PUBLIC_URL || process.env.S3_PUBLIC_URL,
    forcePathStyle:
      process.env.R2_FORCE_PATH_STYLE === "true" ||
      process.env.S3_FORCE_PATH_STYLE === "true",
  };
}

function hasAnyS3Env(s3Env: S3Env): boolean {
  return Boolean(
    s3Env.endpoint ||
      s3Env.accessKeyId ||
      s3Env.secretAccessKey ||
      s3Env.bucket ||
      s3Env.publicUrl
  );
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
// R2Storage is exported via "@dxd/storage/r2" sub-path only
// to avoid pulling Cloudflare types into Node-only consumers.
