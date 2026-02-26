import { createDbClient } from "@dxd/db/client";
import { crawls, crawlLogs, settings, sites } from "@dxd/db/schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

const db = createDbClient(connectionString);

export { db, sites, crawls, crawlLogs, settings };
