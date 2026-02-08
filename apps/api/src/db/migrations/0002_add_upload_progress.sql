ALTER TABLE "crawls"
ADD COLUMN "upload_total_bytes" bigint,
ADD COLUMN "upload_uploaded_bytes" bigint,
ADD COLUMN "upload_files_total" integer,
ADD COLUMN "upload_files_uploaded" integer,
ADD COLUMN "upload_current_file" varchar(500);
