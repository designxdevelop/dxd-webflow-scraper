import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { settings } from "../db/schema.js";
import type { AppEnv } from "../env.js";

const app = new Hono<AppEnv>();
const DEFAULT_GLOBAL_DOWNLOAD_BLACKLIST = [
  "https://js.partnerstack.com/partnerstack.min.js",
  "https://cdn.taboola.com/resources/codeless/codeless-events.js",
  "domain:termly.io",
  "domain:googletagmanager.com",
  "domain:google-analytics.com",
  "domain:facebook.net",
  "domain:connect.facebook.net",
  "domain:redditstatic.com",
  "domain:analytics.tiktok.com",
  "domain:posthog.com",
  "domain:doubleclick.net",
  "domain:googlesyndication.com",
  "domain:googleadservices.com",
  "domain:chatlio.com",
  "domain:intercom.io",
  "domain:hotjar.com",
  "domain:mixpanel.com",
  "domain:segment.io",
  "domain:segment.com",
  "domain:amplitude.com",
  "domain:heapanalytics.com",
  "domain:fullstory.com",
  "domain:clarity.ms",
  "domain:partnerstack.com",
  "domain:taboola.com",
] as const;

function normalizeGlobalDownloadBlacklist(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [...DEFAULT_GLOBAL_DOWNLOAD_BLACKLIST];
  }

  const merged = new Set<string>(DEFAULT_GLOBAL_DOWNLOAD_BLACKLIST);
  for (const item of input) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    merged.add(trimmed);
  }
  return Array.from(merged);
}

// Get all settings
app.get("/", async (c) => {
  const db = c.get("db");
  const allSettings = await db.query.settings.findMany();

  const settingsObj = allSettings.reduce(
    (acc, setting) => {
      acc[setting.key] = setting.value;
      return acc;
    },
    {} as Record<string, unknown>
  );

  return c.json({
    settings: {
      ...settingsObj,
      globalDownloadBlacklist: normalizeGlobalDownloadBlacklist(
        settingsObj.globalDownloadBlacklist
      ),
    },
    defaults: {
      globalDownloadBlacklist: DEFAULT_GLOBAL_DOWNLOAD_BLACKLIST,
    },
  });
});

// Get single setting
app.get("/:key", async (c) => {
  const db = c.get("db");
  const key = c.req.param("key");

  const setting = await db.query.settings.findFirst({
    where: eq(settings.key, key),
  });

  if (!setting) {
    return c.json({ error: "Setting not found" }, 404);
  }

  return c.json({ key: setting.key, value: setting.value });
});

// Update settings (batch)
const updateSettingsSchema = z.record(z.unknown());

app.patch("/", zValidator("json", updateSettingsSchema), async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  const normalizedData: Record<string, unknown> = { ...data };
  if ("globalDownloadBlacklist" in normalizedData) {
    normalizedData.globalDownloadBlacklist = normalizeGlobalDownloadBlacklist(
      normalizedData.globalDownloadBlacklist
    );
  }

  const updates = Object.entries(normalizedData).map(async ([key, value]) => {
    await db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  });

  await Promise.all(updates);

  return c.json({ success: true });
});

// Update single setting
app.put("/:key", async (c) => {
  const db = c.get("db");
  const key = c.req.param("key");
  const body = await c.req.json();
  const value =
    key === "globalDownloadBlacklist"
      ? normalizeGlobalDownloadBlacklist(body.value)
      : body.value;

  await db
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });

  return c.json({ key, value });
});

// Delete setting
app.delete("/:key", async (c) => {
  const db = c.get("db");
  const key = c.req.param("key");

  const [deleted] = await db.delete(settings).where(eq(settings.key, key)).returning();

  if (!deleted) {
    return c.json({ error: "Setting not found" }, 404);
  }

  return c.json({ success: true });
});

export const settingsRoutes = app;
