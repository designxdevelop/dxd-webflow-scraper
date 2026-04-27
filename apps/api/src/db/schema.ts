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
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { AdapterAccountType } from "@auth/core/adapters";

// ============================================================
// Auth.js tables (for GitHub OAuth)
// ============================================================

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  // Custom fields for access control
  role: varchar("role", { length: 50 }).default("user"), // "admin" | "user"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
  ]
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (verificationToken) => [
    primaryKey({
      columns: [verificationToken.identifier, verificationToken.token],
    }),
  ]
);

// Allowed emails/domains for access control
export const allowedEmails = pgTable("allowed_emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }), // specific email or null for domain match
  domain: varchar("domain", { length: 255 }), // domain pattern like "designxdevelop.com"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  createdBy: text("created_by").references(() => users.id),
});

// ============================================================
// Application tables
// ============================================================

export const sites = pgTable("sites", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  url: varchar("url", { length: 500 }).notNull(),

  // Scraping config
  concurrency: integer("concurrency").default(5),
  maxPages: integer("max_pages"),
  excludePatterns: text("exclude_patterns").array(),
  downloadBlacklist: text("download_blacklist").array(),
  removeWebflowBadge: boolean("remove_webflow_badge").default(true),
  maxArchivesToKeep: integer("max_archives_to_keep"),
  redirectsCsv: text("redirects_csv"),

  // Scheduling
  scheduleEnabled: boolean("schedule_enabled").default(false),
  scheduleCron: varchar("schedule_cron", { length: 100 }),
  nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),

  // Storage
  storageType: varchar("storage_type", { length: 50 }).default("local"),
  storagePath: varchar("storage_path", { length: 500 }),

  // Hosting/billing
  hostingAutoPublish: boolean("hosting_auto_publish").default(true),
  hostingBillingEmail: varchar("hosting_billing_email", { length: 255 }),
  hostingPaymentLinkUrl: varchar("hosting_payment_link_url", { length: 1000 }),
  hostingBillingStatus: varchar("hosting_billing_status", { length: 50 }).default("not_sent"),

  // Metadata
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const crawls = pgTable("crawls", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),

  // Status: pending, running, archiving, uploading, completed, timed_out, failed, cancelled
  status: varchar("status", { length: 50 }).default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),

  // Progress
  totalPages: integer("total_pages"),
  succeededPages: integer("succeeded_pages").default(0),
  failedPages: integer("failed_pages").default(0),

  // Upload progress (for status = "uploading")
  uploadTotalBytes: bigint("upload_total_bytes", { mode: "number" }),
  uploadUploadedBytes: bigint("upload_uploaded_bytes", { mode: "number" }),
  uploadFilesTotal: integer("upload_files_total"),
  uploadFilesUploaded: integer("upload_files_uploaded"),
  uploadCurrentFile: varchar("upload_current_file", { length: 500 }),

  // Output
  outputPath: varchar("output_path", { length: 500 }),
  outputSizeBytes: bigint("output_size_bytes", { mode: "number" }),

  // Error tracking
  errorMessage: text("error_message"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const crawlLogs = pgTable("crawl_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  crawlId: uuid("crawl_id").references(() => crawls.id, { onDelete: "cascade" }),

  level: varchar("level", { length: 20 }).notNull(), // info, warn, error, debug
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
  site: one(sites, {
    fields: [sitePublications.siteId],
    references: [sites.id],
  }),
  crawl: one(crawls, {
    fields: [sitePublications.crawlId],
    references: [crawls.id],
  }),
  domains: many(siteDomains),
}));

export const siteDomainsRelations = relations(siteDomains, ({ one }) => ({
  site: one(sites, {
    fields: [siteDomains.siteId],
    references: [sites.id],
  }),
  activePublication: one(sitePublications, {
    fields: [siteDomains.activePublicationId],
    references: [sitePublications.id],
  }),
}));

export const crawlLogsRelations = relations(crawlLogs, ({ one }) => ({
  crawl: one(crawls, {
    fields: [crawlLogs.crawlId],
    references: [crawls.id],
  }),
}));

// Auth relations
export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

// Types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;
export type Crawl = typeof crawls.$inferSelect;
export type NewCrawl = typeof crawls.$inferInsert;
export type CrawlLog = typeof crawlLogs.$inferSelect;
export type NewCrawlLog = typeof crawlLogs.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type AllowedEmail = typeof allowedEmails.$inferSelect;
export type SitePublication = typeof sitePublications.$inferSelect;
export type NewSitePublication = typeof sitePublications.$inferInsert;
export type SiteDomain = typeof siteDomains.$inferSelect;
export type NewSiteDomain = typeof siteDomains.$inferInsert;
