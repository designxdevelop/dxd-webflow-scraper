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
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const sites = pgTable("sites", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  url: varchar("url", { length: 500 }).notNull(),

  // Scraping config
  concurrency: integer("concurrency").default(5),
  maxPages: integer("max_pages"),
  excludePatterns: text("exclude_patterns").array(),
  removeWebflowBadge: boolean("remove_webflow_badge").default(true),
  redirectsCsv: text("redirects_csv"),

  // Scheduling
  scheduleEnabled: boolean("schedule_enabled").default(false),
  scheduleCron: varchar("schedule_cron", { length: 100 }),
  nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),

  // Storage
  storageType: varchar("storage_type", { length: 50 }).default("local"),
  storagePath: varchar("storage_path", { length: 500 }),

  // Metadata
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const crawls = pgTable("crawls", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),

  // Status: pending, running, completed, failed, cancelled
  status: varchar("status", { length: 50 }).default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),

  // Progress
  totalPages: integer("total_pages"),
  succeededPages: integer("succeeded_pages").default(0),
  failedPages: integer("failed_pages").default(0),

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

// Relations
export const sitesRelations = relations(sites, ({ many }) => ({
  crawls: many(crawls),
}));

export const crawlsRelations = relations(crawls, ({ one, many }) => ({
  site: one(sites, {
    fields: [crawls.siteId],
    references: [sites.id],
  }),
  logs: many(crawlLogs),
}));

export const crawlLogsRelations = relations(crawlLogs, ({ one }) => ({
  crawl: one(crawls, {
    fields: [crawlLogs.crawlId],
    references: [crawls.id],
  }),
}));

// Types
export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;
export type Crawl = typeof crawls.$inferSelect;
export type NewCrawl = typeof crawls.$inferInsert;
export type CrawlLog = typeof crawlLogs.$inferSelect;
export type NewCrawlLog = typeof crawlLogs.$inferInsert;
export type Setting = typeof settings.$inferSelect;
