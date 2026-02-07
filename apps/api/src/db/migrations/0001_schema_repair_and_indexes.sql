ALTER TABLE "sites"
ADD COLUMN IF NOT EXISTS "max_archives_to_keep" integer;

CREATE INDEX IF NOT EXISTS "crawls_site_id_created_at_idx"
ON "crawls" ("site_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "crawls_site_id_status_idx"
ON "crawls" ("site_id", "status");

CREATE INDEX IF NOT EXISTS "crawl_logs_crawl_id_created_at_idx"
ON "crawl_logs" ("crawl_id", "created_at" DESC);
