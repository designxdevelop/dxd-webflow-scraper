import type { StorageAdapter } from "@dxd/storage";
import type { Database } from "./db/client.js";
import type { QueueClient, PubSubClient } from "./queue/client.js";

/**
 * Cloudflare Workers bindings — available via c.env in route handlers.
 */
export type Bindings = {
  // Cloudflare services
  HYPERDRIVE: Hyperdrive;
  STORAGE_BUCKET: R2Bucket;

  // Upstash Redis (HTTP-based, Workers-compatible)
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;

  // Auth
  AUTH_SECRET: string;
  AUTH_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;

  // App config
  FRONTEND_URL: string;
  CORS_ALLOWED_ORIGINS: string;
  NODE_ENV: string;
  AUTH_COOKIE_DOMAIN?: string;

  // Worker service (for job enqueue via HTTP)
  WORKER_SERVICE_URL: string;
  WORKER_API_SECRET: string;

  // Storage env vars (used by Node entry only, for backward compat)
  STORAGE_TYPE?: string;
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_PUBLIC_URL?: string;
  S3_FORCE_PATH_STYLE?: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_REGION?: string;
  R2_PUBLIC_URL?: string;
  R2_FORCE_PATH_STYLE?: string;
  FORCE_LOCAL_STORAGE?: string;
  LOCAL_STORAGE_PATH?: string;
};

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
 * Hono environment type combining bindings and variables.
 */
export type AppEnv = {
  Bindings: Bindings;
  Variables: AppVariables;
};
