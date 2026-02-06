import { R2Storage } from "@dxd/storage/r2";
import { createApp } from "./app.js";
import { createDbClient } from "./db/client.js";
import { createHttpQueueClient, createHttpPubSubClient } from "./queue/client.js";
import type { Bindings } from "./env.js";

// ---------------------------------------------------------------------------
// Cloudflare Workers entry point — creates deps from env bindings.
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const app = createApp({
      deps: {
        db: createDbClient(env.HYPERDRIVE.connectionString),
        storage: new R2Storage(env.STORAGE_BUCKET),
        queue: createHttpQueueClient(env.WORKER_SERVICE_URL, env.WORKER_API_SECRET),
        pubsub: createHttpPubSubClient(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN),
      },
      frontendUrl: env.FRONTEND_URL || "https://archiver.designxdevelop.com",
      corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      isProduction: env.NODE_ENV === "production",
    });

    return app.fetch(request, env, ctx);
  },
};
