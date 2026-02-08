import { serve } from "@hono/node-server";
import { getStorage } from "@dxd/storage";
import { createApp } from "./app.js";
import { createDbClient } from "./db/client.js";
import { createNodeQueueClient, createNodePubSubClient } from "./queue/client.js";

// ---------------------------------------------------------------------------
// Node.js entry point — creates deps from process.env, starts HTTP server.
// ---------------------------------------------------------------------------

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const frontendUrl = (process.env.FRONTEND_URL || "https://archiver.designxdevelop.com").replace(
  /\/+$/,
  ""
);
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const isProduction = process.env.NODE_ENV === "production";
const authCookieDomain = process.env.AUTH_COOKIE_DOMAIN;

const app = createApp({
  deps: {
    db: createDbClient(databaseUrl),
    storage: getStorage(),
    queue: createNodeQueueClient(redisUrl),
    pubsub: createNodePubSubClient(redisUrl),
  },
  frontendUrl,
  corsAllowedOrigins,
  isProduction,
  authCookieDomain,
});

// Export for type inference
export type AppType = typeof app;

const port = parseInt(process.env.PORT || process.env.API_PORT || "3001");
console.log(`Starting API server on port ${port}...`);
serve({ fetch: app.fetch, port });
console.log(`API server running at http://localhost:${port}`);
