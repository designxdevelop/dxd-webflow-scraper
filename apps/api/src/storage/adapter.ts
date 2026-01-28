export interface StorageAdapter {
  writeFile(path: string, content: Buffer | string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  readStream(path: string): ReadableStream<Uint8Array>;
  listFiles(prefix: string): Promise<string[]>;
  deleteDir(path: string): Promise<void>;
  getSize(path: string): Promise<number>;
  exists(path: string): Promise<boolean>;
  createTempDir(id: string): Promise<string>;
  moveToFinal(tempDir: string, id: string): Promise<string>;
  getPublicUrl(path: string): string;
}

export type StorageType = "local" | "s3";

export interface StorageConfig {
  type: StorageType;
  localPath?: string;
  s3?: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    region: string;
  };
}
