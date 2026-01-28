import type { StorageAdapter, StorageConfig } from "./adapter.js";
import { LocalStorage } from "./local.js";

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

  // TODO: Implement S3 storage
  throw new Error("S3 storage not yet implemented");
}

export type { StorageAdapter, StorageConfig } from "./adapter.js";
export { LocalStorage } from "./local.js";
