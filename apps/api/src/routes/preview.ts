import { Hono } from "hono";
import type { AppEnv } from "../env.js";

const app = new Hono<AppEnv>();

// Preview is intentionally disabled to keep storage and compute costs low.
app.all("/:crawlId/*", (c) => {
  return c.json(
    {
      error: "Preview is disabled. Download the ZIP archive instead.",
    },
    410
  );
});

export const previewRoutes = app;
