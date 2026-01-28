import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { sitesRoutes } from "./routes/sites.js";
import { crawlsRoutes } from "./routes/crawls.js";
import { settingsRoutes } from "./routes/settings.js";
import { sseRoutes } from "./routes/sse.js";
import { previewRoutes } from "./routes/preview.js";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => {
      // Allow localhost for development and any Railway subdomain
      const allowedPatterns = [
        /^http:\/\/localhost:\d+$/,
        /^https:\/\/.*\.up\.railway\.app$/,
      ];
      if (!origin || allowedPatterns.some((p) => p.test(origin))) {
        return origin || "*";
      }
      return null;
    },
    credentials: true,
  })
);

// Health check
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// API routes
app.route("/api/sites", sitesRoutes);
app.route("/api/crawls", crawlsRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/sse", sseRoutes);

// Preview routes (serve archived files)
app.route("/preview", previewRoutes);

// Export for type inference
export type AppType = typeof app;

// Start server
const port = parseInt(process.env.PORT || process.env.API_PORT || "3001");

console.log(`Starting API server on port ${port}...`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`API server running at http://localhost:${port}`);
