import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { settings } from "../db/schema.js";

const app = new Hono();

// Get all settings
app.get("/", async (c) => {
  const allSettings = await db.query.settings.findMany();

  // Convert to key-value object
  const settingsObj = allSettings.reduce(
    (acc, setting) => {
      acc[setting.key] = setting.value;
      return acc;
    },
    {} as Record<string, unknown>
  );

  return c.json({ settings: settingsObj });
});

// Get single setting
app.get("/:key", async (c) => {
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
  const data = c.req.valid("json");

  const updates = Object.entries(data).map(async ([key, value]) => {
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
  const key = c.req.param("key");
  const body = await c.req.json();

  await db
    .insert(settings)
    .values({ key, value: body.value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: body.value, updatedAt: new Date() },
    });

  return c.json({ key, value: body.value });
});

// Delete setting
app.delete("/:key", async (c) => {
  const key = c.req.param("key");

  const [deleted] = await db.delete(settings).where(eq(settings.key, key)).returning();

  if (!deleted) {
    return c.json({ error: "Setting not found" }, 404);
  }

  return c.json({ success: true });
});

export const settingsRoutes = app;
