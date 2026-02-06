import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { authHandler, initAuthConfig } from "@hono/auth-js";
import { getAuthConfig } from "./auth/config.js";
import { requireAuth, type AuthVariables } from "./auth/middleware.js";
import { sitesRoutes } from "./routes/sites.js";
import { crawlsRoutes } from "./routes/crawls.js";
import { settingsRoutes } from "./routes/settings.js";
import { sseRoutes } from "./routes/sse.js";
import { previewRoutes } from "./routes/preview.js";

const app = new Hono<{ Variables: AuthVariables }>();
const frontendUrl = (process.env.FRONTEND_URL || "https://archiver.designxdevelop.com")
  .replace(/^https\/\//, "https://")
  .replace(/^http\/\//, "http://")
  .replace(/\/+$/, "");

// Initialize Auth.js config
app.use("*", initAuthConfig(getAuthConfig));

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => {
      // Allow localhost for development, Railway subdomains, and custom domains
      const allowedPatterns = [
        /^http:\/\/localhost:\d+$/,
        /^https:\/\/.*\.up\.railway\.app$/,
        /^https:\/\/.*\.designxdevelop\.com$/,
      ];
      if (!origin || allowedPatterns.some((p) => p.test(origin))) {
        return origin || "*";
      }
      return null;
    },
    credentials: true,
  })
);

// Health check (public)
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// Forward auth page redirects to the web app.
app.get("/login", (c) => {
  const search = new URL(c.req.url).search;
  return c.redirect(`${frontendUrl}/login${search}`);
});

// Auth routes (public) - handles /api/auth/*
app.use("/api/auth/*", authHandler());

// Auth check endpoint (public) - returns current session
app.get("/api/me", async (c) => {
  const { getAuthUser } = await import("@hono/auth-js");
  const auth = await getAuthUser(c);
  if (!auth?.session?.user) {
    return c.json({ user: null });
  }
  return c.json({ user: auth.session.user });
});

// Protected API routes - require authentication
app.use("/api/sites/*", requireAuth);
app.use("/api/crawls/*", requireAuth);
app.use("/api/settings/*", requireAuth);
app.use("/api/sse/*", requireAuth);

app.route("/api/sites", sitesRoutes);
app.route("/api/crawls", crawlsRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/sse", sseRoutes);

// Preview routes (serve archived files) - protected
app.use("/preview/*", requireAuth);
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
