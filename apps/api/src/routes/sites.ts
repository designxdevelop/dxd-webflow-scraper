import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, desc, and, inArray } from "drizzle-orm";
import cronParser from "cron-parser";
import { sites, crawls } from "../db/schema.js";
import type { AppEnv } from "../env.js";

const app = new Hono<AppEnv>();

function isValidDownloadBlacklistRule(value: string): boolean {
  if (!value || !value.trim()) {
    return false;
  }

  const trimmed = value.trim();
  const candidate = trimmed.endsWith("*") ? trimmed.slice(0, -1) : trimmed;
  try {
    // eslint-disable-next-line no-new
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
}

function normalizeDownloadBlacklistRules(rules: string[] | null | undefined): string[] | undefined {
  if (!rules) {
    return undefined;
  }

  const normalized = new Set<string>();
  for (const rule of rules) {
    const trimmed = rule.trim();
    if (!trimmed) {
      continue;
    }

    const isPrefix = trimmed.endsWith("*");
    const candidate = isPrefix ? trimmed.slice(0, -1) : trimmed;
    try {
      const parsed = new URL(candidate);
      parsed.hash = "";
      if (!isPrefix) {
        parsed.search = "";
      }
      normalized.add(isPrefix ? `${parsed.toString()}*` : parsed.toString());
    } catch {
      // Ignore invalid values
    }
  }

  return Array.from(normalized);
}

const downloadBlacklistRuleSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(isValidDownloadBlacklistRule, "Expected a URL or URL prefix ending in *");

// Validation schemas
const createSiteSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url(),
  concurrency: z.number().int().min(1).max(30).optional(),
  maxPages: z.number().int().min(1).optional().nullable(),
  excludePatterns: z.array(z.string()).optional(),
  downloadBlacklist: z.array(downloadBlacklistRuleSchema).optional(),
  removeWebflowBadge: z.boolean().optional(),
  maxArchivesToKeep: z.number().int().min(1).max(1000).optional().nullable(),
  redirectsCsv: z.string().optional().nullable(),
  scheduleEnabled: z.boolean().optional(),
  scheduleCron: z.string().optional().nullable(),
  storageType: z.enum(["local", "s3"]).optional(),
  storagePath: z.string().optional().nullable(),
});

const updateSiteSchema = createSiteSchema.partial();

function getNextScheduledAt(scheduleEnabled: boolean, scheduleCron?: string | null): Date | null {
  if (!scheduleEnabled || !scheduleCron) {
    return null;
  }

  try {
    const interval = cronParser.parse(scheduleCron);
    return interval.next().toDate();
  } catch (error) {
    console.error(`Invalid cron expression: ${scheduleCron}`);
    return null;
  }
}

// List all sites
app.get("/", async (c) => {
  const db = c.get("db");
  const allSites = await db.query.sites.findMany({
    orderBy: desc(sites.createdAt),
    with: {
      crawls: {
        orderBy: desc(crawls.createdAt),
        limit: 1,
      },
    },
  });

  return c.json({
    sites: allSites.map((site) => ({
      ...site,
      lastCrawl: site.crawls[0] || null,
    })),
  });
});

// Get single site
app.get("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const site = await db.query.sites.findFirst({
    where: eq(sites.id, id),
    with: {
      crawls: {
        orderBy: desc(crawls.createdAt),
        limit: 10,
      },
    },
  });

  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  return c.json({ site });
});

// Create site
app.post("/", zValidator("json", createSiteSchema), async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");

  const scheduleEnabled = data.scheduleEnabled ?? false;
  const scheduleCron = data.scheduleCron ?? null;
  const nextScheduledAt = getNextScheduledAt(scheduleEnabled, scheduleCron);

  const [site] = await db
    .insert(sites)
    .values({
      name: data.name,
      url: data.url,
      concurrency: data.concurrency ?? 5,
      maxPages: data.maxPages,
      excludePatterns: data.excludePatterns,
      downloadBlacklist: normalizeDownloadBlacklistRules(data.downloadBlacklist),
      removeWebflowBadge: data.removeWebflowBadge ?? true,
      maxArchivesToKeep: data.maxArchivesToKeep ?? null,
      redirectsCsv: data.redirectsCsv,
      scheduleEnabled,
      scheduleCron,
      nextScheduledAt,
      storageType: data.storageType ?? "s3",
      storagePath: data.storagePath,
    })
    .returning();

  return c.json({ site }, 201);
});

// Update site
app.patch("/:id", zValidator("json", updateSiteSchema), async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const data = c.req.valid("json");

  const existing = await db.query.sites.findFirst({
    where: eq(sites.id, id),
  });

  if (!existing) {
    return c.json({ error: "Site not found" }, 404);
  }

  const scheduleEnabled = data.scheduleEnabled ?? existing.scheduleEnabled ?? false;
  const scheduleCron = data.scheduleCron ?? existing.scheduleCron;
  const nextScheduledAt = getNextScheduledAt(scheduleEnabled, scheduleCron);

  const [site] = await db
    .update(sites)
    .set({
      ...data,
      downloadBlacklist: normalizeDownloadBlacklistRules(data.downloadBlacklist),
      scheduleEnabled,
      scheduleCron,
      nextScheduledAt,
      updatedAt: new Date(),
    })
    .where(eq(sites.id, id))
    .returning();

  return c.json({ site });
});

// Delete site
app.delete("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const [site] = await db.delete(sites).where(eq(sites.id, id)).returning();

  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  return c.json({ success: true });
});

// Start a crawl for a site
app.post("/:id/crawl", async (c) => {
  const db = c.get("db");
  const queue = c.get("queue");
  const siteId = c.req.param("id");

  const site = await db.query.sites.findFirst({
    where: eq(sites.id, siteId),
  });

  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  const existing = await db.query.crawls.findFirst({
    where: and(
      eq(crawls.siteId, siteId),
      inArray(crawls.status, ["pending", "running", "uploading"])
    ),
  });

  if (existing) {
    return c.json({ error: `Crawl already ${existing.status}` }, 409);
  }

  // Create crawl record
  const [crawl] = await db
    .insert(crawls)
    .values({
      siteId,
      status: "pending",
    })
    .returning();

  // Queue the job via abstracted client (BullMQ on Node, HTTP on Workers).
  // If enqueue fails, do not leave the crawl stuck as pending with no queue job.
  try {
    await queue.addCrawlJob(siteId, crawl.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown queue error";
    await db
      .update(crawls)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: `Failed to enqueue crawl job: ${message}`,
      })
      .where(eq(crawls.id, crawl.id));

    return c.json({ error: "Failed to queue crawl job" }, 503);
  }

  return c.json({ crawl }, 201);
});

export const sitesRoutes = app;
