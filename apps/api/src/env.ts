import type { StorageAdapter } from "@dxd/storage";
import type { Database } from "./db/client.js";
import type { QueueClient, PubSubClient } from "./queue/client.js";

/**
 * Variables set per-request via context middleware.
 * Accessed in route handlers via c.get("db"), c.get("storage"), etc.
 */
export type AppVariables = {
  db: Database;
  storage: StorageAdapter;
  queue: QueueClient;
  pubsub: PubSubClient;
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
