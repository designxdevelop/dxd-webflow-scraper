ALTER TABLE "site_domains" ADD COLUMN IF NOT EXISTS "ssl_validation_txt_name" varchar(255);
ALTER TABLE "site_domains" ADD COLUMN IF NOT EXISTS "ssl_validation_txt_value" text;
