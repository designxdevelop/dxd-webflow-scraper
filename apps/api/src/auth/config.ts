import GitHub from "@auth/core/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { AuthConfig } from "@auth/core";
import { db } from "../db/client.js";
import { users, accounts, sessions, verificationTokens, allowedEmails } from "../db/schema.js";
import { eq, or } from "drizzle-orm";

const ALLOWED_DOMAIN = "designxdevelop.com";

export function getAuthConfig(): AuthConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const frontendUrl = (process.env.FRONTEND_URL || "https://archiver.designxdevelop.com").replace(/\/+$/, "");

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
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      }),
    ],
    callbacks: {
      async signIn({ user, account, profile }) {
        // Check if user's email is allowed
        if (!user.email) {
          console.log("Sign-in rejected: no email");
          return false;
        }

        const email = user.email.toLowerCase();
        const domain = email.split("@")[1];

        // Check if email domain matches allowed domain
        if (domain === ALLOWED_DOMAIN) {
          console.log(`Sign-in allowed: ${email} (domain match)`);
          return true;
        }

        // Check allowed_emails table for specific email or domain
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
        // Add user ID and role to session
        if (session.user) {
          session.user.id = user.id;
          // Fetch role from DB
          const dbUser = await db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, user.id))
            .limit(1);
          (session.user as any).role = dbUser[0]?.role || "user";
        }
        return session;
      },
      async redirect({ url, baseUrl }) {
        // If the URL starts with the frontend domain, allow it
        if (url.startsWith(frontendUrl)) {
          return url;
        }
        // If it's a relative URL, redirect to frontend
        if (url.startsWith("/")) {
          return `${frontendUrl}${url}`;
        }
        // Default to frontend home
        return frontendUrl;
      },
    },
    pages: {
      signIn: "/login",
      error: "/login",
    },
    // API and web are on different Railway subdomains in production.
    // Cross-site requests require SameSite=None + Secure cookies.
    cookies: isProduction
      ? {
          sessionToken: {
            options: { sameSite: "none", secure: true },
          },
          callbackUrl: {
            options: { sameSite: "none", secure: true },
          },
          csrfToken: {
            options: { sameSite: "none", secure: true },
          },
        }
      : undefined,
    trustHost: true,
    secret: process.env.AUTH_SECRET,
  };
}
