import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Schema (duplicated from API to avoid cross-package imports)
export const sites = pgTable("sites", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  url: varchar("url", { length: 500 }).notNull(),
  concurrency: integer("concurrency").default(5),
  maxPages: integer("max_pages"),
  excludePatterns: text("exclude_patterns").array(),
  downloadBlacklist: text("download_blacklist").array(),
  removeWebflowBadge: boolean("remove_webflow_badge").default(true),
  maxArchivesToKeep: integer("max_archives_to_keep"),
  redirectsCsv: text("redirects_csv"),
  scheduleEnabled: boolean("schedule_enabled").default(false),
  scheduleCron: varchar("schedule_cron", { length: 100 }),
  nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),
  storageType: varchar("storage_type", { length: 50 }).default("local"),
  storagePath: varchar("storage_path", { length: 500 }),
  hostingAutoPublish: boolean("hosting_auto_publish").default(true),
  hostingBillingEmail: varchar("hosting_billing_email", { length: 255 }),
  hostingPaymentLinkUrl: varchar("hosting_payment_link_url", { length: 1000 }),
  hostingBillingStatus: varchar("hosting_billing_status", { length: 50 }).default("not_sent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const crawls = pgTable("crawls", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 50 }).default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  totalPages: integer("total_pages"),
  succeededPages: integer("succeeded_pages").default(0),
  failedPages: integer("failed_pages").default(0),
  // Upload progress fields
  uploadTotalBytes: bigint("upload_total_bytes", { mode: "number" }),
  uploadUploadedBytes: bigint("upload_uploaded_bytes", { mode: "number" }),
  uploadFilesTotal: integer("upload_files_total"),
  uploadFilesUploaded: integer("upload_files_uploaded"),
  uploadCurrentFile: varchar("upload_current_file", { length: 500 }),
  outputPath: varchar("output_path", { length: 500 }),
  outputSizeBytes: bigint("output_size_bytes", { mode: "number" }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const crawlLogs = pgTable("crawl_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  crawlId: uuid("crawl_id").references(() => crawls.id, { onDelete: "cascade" }),
  level: varchar("level", { length: 20 }).notNull(),
  message: text("message").notNull(),
  url: varchar("url", { length: 500 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const settings = pgTable("settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const sitePublications = pgTable("site_publications", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  crawlId: uuid("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  r2Prefix: varchar("r2_prefix", { length: 500 }).notNull(),
  fileCount: integer("file_count"),
  totalBytes: bigint("total_bytes", { mode: "number" }),
  errorMessage: text("error_message"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const siteDomains = pgTable(
  "site_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
    hostname: varchar("hostname", { length: 255 }).notNull(),
    status: varchar("status", { length: 50 }).notNull().default("pending_dns"),
    cnameTarget: varchar("cname_target", { length: 255 }).notNull(),
    activePublicationId: uuid("active_publication_id").references(() => sitePublications.id, { onDelete: "set null" }),
    redirectEnabled: boolean("redirect_enabled").default(false),
    redirectTargetOrigin: varchar("redirect_target_origin", { length: 500 }),
    cloudflareHostnameId: varchar("cloudflare_hostname_id", { length: 255 }),
    ownershipVerificationName: varchar("ownership_verification_name", { length: 255 }),
    ownershipVerificationValue: text("ownership_verification_value"),
    sslValidationTxtName: varchar("ssl_validation_txt_name", { length: 255 }),
    sslValidationTxtValue: text("ssl_validation_txt_value"),
    sslStatus: varchar("ssl_status", { length: 100 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (domain) => [uniqueIndex("site_domains_hostname_idx").on(domain.hostname)]
);

// Relations
export const sitesRelations = relations(sites, ({ many }) => ({
  crawls: many(crawls),
  publications: many(sitePublications),
  domains: many(siteDomains),
}));

export const crawlsRelations = relations(crawls, ({ one, many }) => ({
  site: one(sites, {
    fields: [crawls.siteId],
    references: [sites.id],
  }),
  logs: many(crawlLogs),
  publications: many(sitePublications),
}));

export const sitePublicationsRelations = relations(sitePublications, ({ one, many }) => ({
  site: one(sites, { fields: [sitePublications.siteId], references: [sites.id] }),
  crawl: one(crawls, { fields: [sitePublications.crawlId], references: [crawls.id] }),
  domains: many(siteDomains),
}));

export const siteDomainsRelations = relations(siteDomains, ({ one }) => ({
  site: one(sites, { fields: [siteDomains.siteId], references: [sites.id] }),
  activePublication: one(sitePublications, {
    fields: [siteDomains.activePublicationId],
    references: [sitePublications.id],
  }),
}));

// Database client
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

const client = postgres(connectionString);
export const db = drizzle(client, {
  schema: {
    sites,
    crawls,
    crawlLogs,
    settings,
    sitePublications,
    siteDomains,
    sitesRelations,
    crawlsRelations,
    sitePublicationsRelations,
    siteDomainsRelations,
  },
});
