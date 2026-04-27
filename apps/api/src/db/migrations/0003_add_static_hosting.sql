CREATE TABLE IF NOT EXISTS "site_publications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "crawl_id" uuid NOT NULL REFERENCES "crawls"("id") ON DELETE cascade,
  "status" varchar(50) DEFAULT 'pending' NOT NULL,
  "r2_prefix" varchar(500) NOT NULL,
  "file_count" integer,
  "total_bytes" bigint,
  "error_message" text,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "site_domains" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "hostname" varchar(255) NOT NULL,
  "status" varchar(50) DEFAULT 'pending_dns' NOT NULL,
  "cname_target" varchar(255) NOT NULL,
  "active_publication_id" uuid REFERENCES "site_publications"("id") ON DELETE set null,
  "cloudflare_hostname_id" varchar(255),
  "ownership_verification_name" varchar(255),
  "ownership_verification_value" text,
  "ssl_status" varchar(100),
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "site_domains_hostname_idx" ON "site_domains" ("hostname");
CREATE INDEX IF NOT EXISTS "site_publications_site_id_idx" ON "site_publications" ("site_id");
CREATE INDEX IF NOT EXISTS "site_domains_site_id_idx" ON "site_domains" ("site_id");
