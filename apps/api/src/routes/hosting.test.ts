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
});
