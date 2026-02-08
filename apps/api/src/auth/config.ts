import GitHub from "@auth/core/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { AuthConfig } from "@auth/core";
import type { Database } from "../db/client.js";
import { users, accounts, sessions, verificationTokens, allowedEmails } from "../db/schema.js";
import { eq, or } from "drizzle-orm";

const ALLOWED_DOMAIN = "designxdevelop.com";

export interface AuthConfigOptions {
  isProduction: boolean;
  frontendUrl: string;
  authSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
}

/**
 * Returns a function suitable for initAuthConfig() that creates AuthConfig
 * using the provided database client and options.
 *
 * Workers: db comes from context, env vars from bindings.
 * Node: db comes from singleton, env vars from process.env.
 */
export function getAuthConfigFactory(db: Database, options: AuthConfigOptions) {
  return function getAuthConfig(): AuthConfig {
    const frontendUrl = options.frontendUrl.replace(/\/+$/, "");
    const isProduction = options.isProduction;

    return {
      basePath: "/api/auth",
      adapter: DrizzleAdapter(db, {
        usersTable: users,
        accountsTable: accounts,
        sessionsTable: sessions,
        verificationTokensTable: verificationTokens,
      }),
      providers: [
        GitHub({
          clientId: options.githubClientId || process.env.GITHUB_CLIENT_ID!,
          clientSecret: options.githubClientSecret || process.env.GITHUB_CLIENT_SECRET!,
        }),
      ],
      callbacks: {
        async signIn({ user }) {
          if (!user.email) {
            console.log("Sign-in rejected: no email");
            return false;
          }

          const email = user.email.toLowerCase();
          const domain = email.split("@")[1];

          if (domain === ALLOWED_DOMAIN) {
            console.log(`Sign-in allowed: ${email} (domain match)`);
            return true;
          }

          const allowed = await db
            .select()
            .from(allowedEmails)
            .where(or(eq(allowedEmails.email, email), eq(allowedEmails.domain, domain)))
            .limit(1);

          if (allowed.length > 0) {
            console.log(`Sign-in allowed: ${email} (allowlist match)`);
            return true;
          }

          console.log(`Sign-in rejected: ${email} (not in allowlist)`);
          return false;
        },
        async session({ session, user }) {
          if (session.user) {
            session.user.id = user.id;
            const dbUser = await db
              .select({ role: users.role })
              .from(users)
              .where(eq(users.id, user.id))
              .limit(1);
            (session.user as any).role = dbUser[0]?.role || "user";
          }
          return session;
        },
        async redirect({ url }) {
          if (url.startsWith(frontendUrl)) {
            return url;
          }
          if (url.startsWith("/")) {
            return `${frontendUrl}${url}`;
          }
          return frontendUrl;
        },
      },
      pages: {
        signIn: "/login",
        error: "/login",
      },
      cookies: isProduction
        ? {
            sessionToken: {
              name: "next-auth.session-token",
              options: {
                httpOnly: true,
                sameSite: "none",
                secure: true,
                domain: ".designxdevelop.com",
              },
            },
            callbackUrl: {
              name: "next-auth.callback-url",
              options: {
                sameSite: "none",
                secure: true,
                domain: ".designxdevelop.com",
              },
            },
            csrfToken: {
              name: "next-auth.csrf-token",
              options: {
                httpOnly: true,
                sameSite: "none",
                secure: true,
                domain: ".designxdevelop.com",
              },
            },
          }
        : undefined,
      trustHost: true,
      secret: options.authSecret || process.env.AUTH_SECRET,
    };
  };
}

// ---------------------------------------------------------------------------
// Legacy export for backward compatibility during migration.
// The Node entry point now uses getAuthConfigFactory() directly via createApp().
// ---------------------------------------------------------------------------

/** @deprecated Use getAuthConfigFactory() instead. */
export function getAuthConfig(): AuthConfig {
  // This is only called if something still imports the old API.
  // It relies on the db singleton proxy from client.ts.
  const { db } = require("../db/client.js") as { db: Database };
  const isProduction = process.env.NODE_ENV === "production";
  const frontendUrl = process.env.FRONTEND_URL || "https://archiver.designxdevelop.com";
  return getAuthConfigFactory(db, { isProduction, frontendUrl })();
}
