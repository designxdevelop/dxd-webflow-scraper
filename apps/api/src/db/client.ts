import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Create a Drizzle database client from a connection string.
 * In Workers: connectionString comes from env.HYPERDRIVE.connectionString
 * In Node: connectionString comes from process.env.DATABASE_URL
 */
export function createDbClient(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDbClient>;

// ---------------------------------------------------------------------------
// Legacy singleton for backward compat during migration.
// Routes that haven't been migrated to context-based deps can still import this.
// Will be removed once all routes use c.get("db").
// ---------------------------------------------------------------------------
let _singleton: Database | null = null;

/** @deprecated Use c.get("db") from Hono context instead. */
export function getDb(): Database {
  if (!_singleton) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    _singleton = createDbClient(connectionString);
  }
  return _singleton;
}

/** @deprecated Singleton kept for migration period. */
export const db = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
