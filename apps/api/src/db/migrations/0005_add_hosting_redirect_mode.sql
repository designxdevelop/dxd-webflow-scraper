ALTER TABLE "site_domains" ADD COLUMN IF NOT EXISTS "redirect_enabled" boolean DEFAULT false;
ALTER TABLE "site_domains" ADD COLUMN IF NOT EXISTS "redirect_target_origin" varchar(500);
