ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "hosting_auto_publish" boolean DEFAULT true;
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "hosting_billing_email" varchar(255);
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "hosting_payment_link_url" varchar(1000);
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "hosting_billing_status" varchar(50) DEFAULT 'not_sent';
