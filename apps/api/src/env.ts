import type { Database } from "./db/client.js";
import type { QueueClient } from "./queue/client.js";

export interface ArchiveStorage {
  get(key: string): Promise<ReadableStream | null>;
}

/**
 * Variables set per-request via context middleware.
 * Accessed in route handlers via c.get("db"), c.get("storage"), etc.
 */
export type AppVariables = {
  db: Database;
  storage: ArchiveStorage;
  queue: QueueClient;
  // User set by auth middleware
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
    role?: string;
  } | null;
};

/**
 * Hono environment type.
 */
export type AppEnv = {
  Variables: AppVariables;
};
