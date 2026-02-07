export interface MoveToFinalProgress {
  totalBytes: number;
  uploadedBytes: number;
  filesTotal: number;
  filesUploaded: number;
  currentFile?: string;
}

export interface MoveToFinalOptions {
  onProgress?: (progress: MoveToFinalProgress) => void | Promise<void>;
}

export interface StorageAdapter {
  writeFile(path: string, content: Buffer | string): Promise<void>;
  writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  readStream(path: string): ReadableStream<Uint8Array>;
  listFiles(prefix: string): Promise<string[]>;
  deleteDir(path: string): Promise<void>;
  getSize(path: string): Promise<number>;
  exists(path: string): Promise<boolean>;
  createTempDir(id: string): Promise<string>;
  moveToFinal(tempDir: string, id: string, options?: MoveToFinalOptions): Promise<string>;
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
    publicUrl?: string;
    forcePathStyle?: boolean;
  };
}
