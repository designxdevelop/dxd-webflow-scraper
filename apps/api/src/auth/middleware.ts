import { Context, Next } from "hono";
import { getAuthUser } from "@hono/auth-js";

export type AuthUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string;
};

export type AuthVariables = {
  user: AuthUser | null;
};

/**
 * Middleware that requires authentication.
 * Returns 401 if user is not logged in.
 */
export async function requireAuth(c: Context<{ Variables: AuthVariables }>, next: Next) {
  const authUser = await getAuthUser(c);

  if (!authUser?.session?.user) {
    return c.json({ error: "Unauthorized", message: "Please sign in to access this resource" }, 401);
  }

  c.set("user", authUser.session.user as AuthUser);
  return next();
}

/**
 * Middleware that optionally loads auth.
 * Sets user to null if not logged in, but doesn't block.
 */
export async function optionalAuth(c: Context<{ Variables: AuthVariables }>, next: Next) {
  const authUser = await getAuthUser(c);
  c.set("user", (authUser?.session?.user as AuthUser) || null);
  return next();
}

/**
 * Middleware that requires admin role.
 * Must be used after requireAuth.
 */
export async function requireAdmin(c: Context<{ Variables: AuthVariables }>, next: Next) {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "Unauthorized", message: "Please sign in to access this resource" }, 401);
  }

  if (user.role !== "admin") {
    return c.json({ error: "Forbidden", message: "Admin access required" }, 403);
  }

  return next();
}
