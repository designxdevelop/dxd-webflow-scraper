import { getContainer } from "@cloudflare/containers";
import { createApp } from "./app.js";
import { createDbClient } from "./db/client.js";
import { createContainerQueueClient } from "./queue/client.js";
import { runScheduledTick } from "./scheduler.js";
import type { Crawler } from "./crawler.js";

export { Crawler } from "./crawler.js";

// ---------------------------------------------------------------------------
// Cloudflare Workers entry point. Secrets/vars also reach process.env via nodejs_compat.
// ---------------------------------------------------------------------------

export type Env = {
  HYPERDRIVE: Hyperdrive;
  STORAGE_BUCKET: R2Bucket;
  CRAWLER: DurableObjectNamespace<Crawler>;
  FRONTEND_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  NODE_ENV?: string;
  AUTH_COOKIE_DOMAIN?: string;
  /** "true" once the Railway worker is stopped: enables cron scheduling and full queue draining. */
  CRAWLER_OWNS_QUEUE?: string;
  /** Bearer token for POST /internal/crawler/kick (smoke tests). Unset = endpoint disabled. */
  CRAWLER_TRIGGER_SECRET?: string;
  /** Direct Postgres URL for the container (Hyperdrive is Worker-only). */
  CRAWLER_DATABASE_URL: string;
} & Partial<Record<string, string>>;

function createDeps(env: Env) {
  return {
    db: createDbClient(env.HYPERDRIVE.connectionString),
    storage: {
      get: async (key: string) => (await env.STORAGE_BUCKET.get(key))?.body ?? null,
    },
    queue: createContainerQueueClient(env.CRAWLER),
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/crawler/kick" && request.method === "POST") {
      const secret = env.CRAWLER_TRIGGER_SECRET;
      if (!secret || request.headers.get("Authorization") !== `Bearer ${secret}`) {
        return new Response("Not found", { status: 404 });
      }
      const { crawlId } = (await request.json().catch(() => ({}))) as { crawlId?: string };
      await getContainer(env.CRAWLER).kick(crawlId);
      return Response.json({ ok: true, crawlId: crawlId ?? null });
    }

    const app = createApp({
      deps: createDeps(env),
      frontendUrl: (env.FRONTEND_URL || "https://zip.designxdevelop.com").replace(/\/+$/, ""),
      corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      isProduction: env.NODE_ENV === "production",
      authCookieDomain: env.AUTH_COOKIE_DOMAIN,
    });
    return app.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.CRAWLER_OWNS_QUEUE !== "true") return;
    ctx.waitUntil(runScheduledTick(createDbClient(env.HYPERDRIVE.connectionString), () => getContainer(env.CRAWLER).kick()));
  },
};
