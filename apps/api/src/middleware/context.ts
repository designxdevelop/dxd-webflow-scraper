import { createMiddleware } from "hono/factory";
import type { AppEnv, ArchiveStorage } from "../env.js";
import type { Database } from "../db/client.js";
import type { QueueClient } from "../queue/client.js";

/**
 * Dependencies injected into the Hono app.
 */
export interface AppDeps {
  db: Database;
  storage: ArchiveStorage;
  queue: QueueClient;
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
    await next();
  });
}
