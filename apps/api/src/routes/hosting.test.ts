import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { hostingRoutes } from "./hosting.js";

describe("hosting routes", () => {
  it("returns billing settings even when hosting CNAME is not configured", async () => {
    const app = new Hono();
    const db = {
      query: {
        sites: {
          findFirst: async () => ({
            id: "site-1",
            hostingAutoPublish: true,
            hostingBillingEmail: "owner@example.com",
            hostingPaymentLinkUrl: "https://buy.stripe.com/test",
            hostingBillingStatus: "sent",
          }),
        },
        sitePublications: { findMany: async () => [] },
        siteDomains: { findMany: async () => [] },
      },
    };

    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/api/sites", hostingRoutes);

    const response = await app.request("/api/sites/site-1/hosting");
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.cnameTarget, null);
    assert.deepEqual(payload.settings, {
      hostingAutoPublish: true,
      hostingBillingEmail: "owner@example.com",
      hostingPaymentLinkUrl: "https://buy.stripe.com/test",
      hostingBillingStatus: "sent",
    });
  });

  it("returns the existing same-site domain when a re-add hits the hostname unique constraint", async () => {
    const existingDomain = {
      id: "domain-1",
      siteId: "site-1",
      hostname: "backup.example.com",
      cnameTarget: "hosting.example.com",
      status: "pending_dns",
    };
    const app = new Hono();
    const db = {
      query: {
        sites: {
          findFirst: async () => ({ id: "site-1", url: "https://example.com" }),
        },
        sitePublications: { findFirst: async () => null },
        siteDomains: { findFirst: async () => existingDomain },
      },
      insert: () => ({
        values: () => ({
          returning: async () => {
            throw { code: "23505" };
          },
        }),
      }),
    };

    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/api/sites", hostingRoutes);

    const response = await app.request(
      "/api/sites/site-1/domains",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostname: "backup.example.com" }),
      },
      {
        HOSTING_CNAME_TARGET: "hosting.example.com",
        CLOUDFLARE_ZONE_ID: "zone-1",
        CLOUDFLARE_API_TOKEN: "token-1",
      }
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.alreadyExists, true);
    assert.deepEqual(payload.domain, existingDomain);
  });

  it("returns the existing same-site domain when Drizzle wraps a hostname unique constraint", async () => {
    const existingDomain = {
      id: "domain-1",
      siteId: "site-1",
      hostname: "backup.example.com",
      cnameTarget: "hosting.example.com",
      status: "pending_dns",
    };
    const app = new Hono();
    const db = {
      query: {
        sites: {
          findFirst: async () => ({ id: "site-1", url: "https://example.com" }),
        },
        sitePublications: { findFirst: async () => null },
        siteDomains: { findFirst: async () => existingDomain },
      },
      insert: () => ({
        values: () => ({
          returning: async () => {
            throw new Error(
              'Failed query: insert into "site_domains" values (...) returning "id"\nparams: site-1,backup.example.com',
              { cause: { code: "23505", constraint_name: "site_domains_hostname_idx" } }
            );
          },
        }),
      }),
    };

    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/api/sites", hostingRoutes);

    const response = await app.request(
      "/api/sites/site-1/domains",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostname: "backup.example.com" }),
      },
      {
        HOSTING_CNAME_TARGET: "hosting.example.com",
        CLOUDFLARE_ZONE_ID: "zone-1",
        CLOUDFLARE_API_TOKEN: "token-1",
      }
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.alreadyExists, true);
    assert.deepEqual(payload.domain, existingDomain);
  });

  it("removes the local domain when Cloudflare custom hostname is already gone", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "custom hostname not found" }] }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });

    try {
      let deleted = false;
      const app = new Hono();
      const db = {
        query: {
          siteDomains: {
            findFirst: async () => ({
              id: "domain-1",
              siteId: "site-1",
              hostname: "backup.example.com",
              cloudflareHostnameId: "cf-hostname-1",
            }),
          },
        },
        delete: () => ({
          where: async () => {
            deleted = true;
          },
        }),
      };

      app.use("*", async (c, next) => {
        c.set("db", db);
        await next();
      });
      app.route("/api/sites", hostingRoutes);

      const response = await app.request(
        "/api/sites/site-1/domains/domain-1",
        { method: "DELETE" },
        { CLOUDFLARE_ZONE_ID: "zone-1", CLOUDFLARE_API_TOKEN: "token-1" }
      );
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(deleted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
