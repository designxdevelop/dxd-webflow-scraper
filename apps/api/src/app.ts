import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authHandler, initAuthConfig } from "@hono/auth-js";
import type { AppEnv } from "./env.js";
import { contextMiddleware, type AppDeps } from "./middleware/context.js";
import { getAuthConfigFactory } from "./auth/config.js";
import { requireAuth } from "./auth/middleware.js";
import { sitesRoutes } from "./routes/sites.js";
import { crawlsRoutes } from "./routes/crawls.js";
import { settingsRoutes } from "./routes/settings.js";
import { sseRoutes } from "./routes/sse.js";
import { previewRoutes } from "./routes/preview.js";

export interface AppConfig {
  deps: AppDeps;
  frontendUrl: string;
  corsAllowedOrigins: string[];
  isProduction: boolean;
  authCookieDomain?: string;
}

function toOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function createApp(config: AppConfig) {
  const { deps, isProduction } = config;
  const frontendUrl = config.frontendUrl.replace(/\/+$/, "");
  const frontendOrigin = toOrigin(frontendUrl);
  const extraAllowedOrigins = config.corsAllowedOrigins
    .map(toOrigin)
    .filter((origin): origin is string => Boolean(origin));

  function isAllowedOrigin(origin?: string | null): origin is string {
    if (!origin) return false;
    if (frontendOrigin && origin === frontendOrigin) return true;
    if (extraAllowedOrigins.includes(origin)) return true;

    const allowedPatterns = [
      /^http:\/\/localhost:\d+$/,
      /^https:\/\/.*\.up\.railway\.app$/,
      /^https:\/\/.*\.designxdevelop\.com$/,
    ];
    return allowedPatterns.some((pattern) => pattern.test(origin));
  }

  const app = new Hono<AppEnv>();

  // Inject dependencies into context
  app.use("*", contextMiddleware(deps));

  // Auth.js config — uses deps.db from context
  app.use(
    "*",
    initAuthConfig(
      getAuthConfigFactory(deps.db, {
        isProduction,
        frontendUrl,
        cookieDomain: config.authCookieDomain,
      })
    )
  );

  // Logging
  app.use("*", logger());

  // CORS
  app.use(
    "*",
    cors({
      origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
      credentials: true,
    })
  );

  // Ensure SSE responses include CORS headers
  app.use("/api/sse/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (isAllowedOrigin(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
    }
    await next();
  });

  // Health check (public)
  app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

  // Login redirect
  app.get("/login", (c) => {
    const search = new URL(c.req.url).search;
    return c.redirect(`${frontendUrl}/login${search}`);
  });

  // Auth routes (public)
  app.use("/api/auth/*", authHandler());

  // Auth check (public)
  app.get("/api/me", async (c) => {
    const { getAuthUser } = await import("@hono/auth-js");
    const auth = await getAuthUser(c);
    if (!auth?.session?.user) {
      return c.json({ user: null });
    }
    return c.json({ user: auth.session.user });
  });

  // Protected routes
  app.use("/api/sites/*", requireAuth);
  app.use("/api/crawls/*", requireAuth);
  app.use("/api/settings/*", requireAuth);
  app.use("/api/sse/*", requireAuth);

  app.route("/api/sites", sitesRoutes);
  app.route("/api/crawls", crawlsRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/sse", sseRoutes);

  // Defense-in-depth: keep preview responses out of search indexes.
  app.use("/preview/*", async (c, next) => {
    await next();
    c.res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, noimageindex");
    c.res.headers.set("Referrer-Policy", "no-referrer");
  });

  // Preview routes (protected)
  app.use("/preview/*", requireAuth);
  app.route("/preview", previewRoutes);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
