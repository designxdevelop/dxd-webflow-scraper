import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, desc } from "drizzle-orm";
import cronParser from "cron-parser";
import { db } from "../db/client.js";
import { sites, crawls } from "../db/schema.js";
import { crawlQueue } from "../queue/client.js";

const app = new Hono();

// Validation schemas
const createSiteSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url(),
  concurrency: z.number().int().min(1).max(20).optional(),
  maxPages: z.number().int().min(1).optional().nullable(),
  excludePatterns: z.array(z.string()).optional(),
  removeWebflowBadge: z.boolean().optional(),
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

function getDefaultStorageType(): "local" | "s3" {
  const explicit = process.env.STORAGE_TYPE;
  if (explicit === "s3" || explicit === "local") {
    return explicit;
  }

  const endpoint = process.env.S3_ENDPOINT || process.env.R2_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET;

  const hasS3Config = Boolean(endpoint && accessKeyId && secretAccessKey && bucket);
  return hasS3Config ? "s3" : "local";
}

// List all sites
app.get("/", async (c) => {
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
      removeWebflowBadge: data.removeWebflowBadge ?? true,
      redirectsCsv: data.redirectsCsv,
      scheduleEnabled,
      scheduleCron,
      nextScheduledAt,
      storageType: data.storageType ?? getDefaultStorageType(),
      storagePath: data.storagePath,
    })
    .returning();

  return c.json({ site }, 201);
});

// Update site
app.patch("/:id", zValidator("json", updateSiteSchema), async (c) => {
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
  const id = c.req.param("id");

  const [site] = await db.delete(sites).where(eq(sites.id, id)).returning();

  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  return c.json({ success: true });
});

// Start a crawl for a site
app.post("/:id/crawl", async (c) => {
  const siteId = c.req.param("id");

  const site = await db.query.sites.findFirst({
    where: eq(sites.id, siteId),
  });

  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  // Create crawl record
  const [crawl] = await db
    .insert(crawls)
    .values({
      siteId,
      status: "pending",
    })
    .returning();

  // Queue the job
  await crawlQueue.add("crawl", {
    siteId,
    crawlId: crawl.id,
  });

  return c.json({ crawl }, 201);
});

export const sitesRoutes = app;
