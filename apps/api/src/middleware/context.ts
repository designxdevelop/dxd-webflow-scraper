import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env.js";
import type { StorageAdapter } from "@dxd/storage";
import type { Database } from "../db/client.js";
import type { QueueClient, PubSubClient } from "../queue/client.js";

/**
 * Dependencies injected into the Hono app.
 * Created differently for Node (singletons from process.env) vs Workers (from bindings).
 */
export interface AppDeps {
  db: Database;
  storage: StorageAdapter;
  queue: QueueClient;
  pubsub: PubSubClient;
}

/**
 * Middleware that sets per-request dependencies on the Hono context.
 * Route handlers access them via c.get("db"), c.get("storage"), etc.
 */
export function contextMiddleware(deps: AppDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set("db", deps.db);
    c.set("storage", deps.storage);
    c.set("queue", deps.queue);
    c.set("pubsub", deps.pubsub);
    await next();
  });
}
