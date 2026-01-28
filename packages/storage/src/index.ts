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
  const type = (process.env.STORAGE_TYPE || "local") as "local" | "s3";

  if (type === "s3") {
    return {
      type: "s3",
      s3: {
        endpoint: process.env.S3_ENDPOINT!,
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
        bucket: process.env.S3_BUCKET!,
        region: process.env.S3_REGION || "auto",
        publicUrl: process.env.S3_PUBLIC_URL,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      },
    };
  }

  return {
    type: "local",
    localPath: process.env.LOCAL_STORAGE_PATH || "./data",
  };
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
