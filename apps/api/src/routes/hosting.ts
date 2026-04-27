import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { crawls, siteDomains, sitePublications, sites } from "../db/schema.js";
import type { AppEnv } from "../env.js";

const app = new Hono<AppEnv>();

const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(255)
  .refine((value) => !value.startsWith("*."), "Use a concrete client subdomain, not a wildcard")
  .refine((value) => !value.startsWith("http://") && !value.startsWith("https://"), "Enter a hostname, not a URL")
  .refine((value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value), "Invalid hostname");

const createPublicationSchema = z.object({
  crawlId: z.string().uuid().optional(),
  activate: z.boolean().optional().default(true),
});

const createDomainSchema = z.object({
  hostname: hostnameSchema,
});

const activatePublicationSchema = z.object({
  publicationId: z.string().uuid(),
});

const updateDomainSchema = z.object({
  redirectEnabled: z.boolean().optional(),
  redirectTargetOrigin: z.string().url().optional().nullable(),
});

const updateHostingSettingsSchema = z.object({
  hostingAutoPublish: z.boolean().optional(),
  hostingBillingEmail: z.string().email().optional().nullable(),
  hostingPaymentLinkUrl: z.string().url().optional().nullable(),
  hostingBillingStatus: z.enum(["not_sent", "sent", "paid", "past_due", "cancelled"]).optional(),
});

function getHostingCnameTarget(c: { env?: { HOSTING_CNAME_TARGET?: string } }): string {
  const target = c.env?.HOSTING_CNAME_TARGET || process.env.HOSTING_CNAME_TARGET;
  if (!target) {
    throw new Error("HOSTING_CNAME_TARGET is required to create hosted domains");
  }
  return target.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
}

function getCloudflareConfig(c: { env?: { CLOUDFLARE_ZONE_ID?: string; CLOUDFLARE_API_TOKEN?: string } }) {
  const zoneId = c.env?.CLOUDFLARE_ZONE_ID || process.env.CLOUDFLARE_ZONE_ID;
  const apiToken = c.env?.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!zoneId || !apiToken) return null;
  return { zoneId, apiToken };
}

async function createCloudflareCustomHostname(
  c: { env?: { CLOUDFLARE_ZONE_ID?: string; CLOUDFLARE_API_TOKEN?: string } },
  hostname: string
) {
  const config = getCloudflareConfig(c);
  if (!config) return null;

  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/custom_hostnames`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      hostname,
      ssl: {
        method: "txt",
        type: "dv",
        settings: {
          min_tls_version: "1.2",
        },
      },
    }),
  });

  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok || payload?.success === false) {
    const message = payload?.errors?.[0]?.message || `Cloudflare custom hostname failed with ${response.status}`;
    throw new Error(message);
  }

  return payload?.result ?? null;
}

async function deleteCloudflareCustomHostname(
  c: { env?: { CLOUDFLARE_ZONE_ID?: string; CLOUDFLARE_API_TOKEN?: string } },
  cloudflareHostnameId: string
) {
  const config = getCloudflareConfig(c);
  if (!config) return;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/custom_hostnames/${cloudflareHostnameId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
      },
    }
  );

  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok || payload?.success === false) {
    const message = payload?.errors?.[0]?.message || `Cloudflare custom hostname delete failed with ${response.status}`;
    throw new Error(message);
  }
}

async function syncCloudflareCustomHostname(
  c: { env?: { CLOUDFLARE_ZONE_ID?: string; CLOUDFLARE_API_TOKEN?: string } },
  cloudflareHostnameId: string
) {
  const config = getCloudflareConfig(c);
  if (!config) return null;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/custom_hostnames/${cloudflareHostnameId}`,
    {
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
      },
    }
  );

  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok || payload?.success === false) {
    const message = payload?.errors?.[0]?.message || `Cloudflare custom hostname sync failed with ${response.status}`;
    throw new Error(message);
  }

  return payload?.result ?? null;
}

function extractCloudflareDomainFields(result: any) {
  const ownership = result?.ownership_verification ?? result?.ownership_verification_http;
  const ssl = result?.ssl;
  const status = result?.status === "active" && ssl?.status === "active" ? "active" : "pending_dns";

  return {
    cloudflareHostnameId: typeof result?.id === "string" ? result.id : null,
    ownershipVerificationName: typeof ownership?.name === "string" ? ownership.name : null,
    ownershipVerificationValue: typeof ownership?.value === "string" ? ownership.value : null,
    sslStatus: typeof ssl?.status === "string" ? ssl.status : null,
    status,
  };
}

function toOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

app.get("/:siteId/hosting", async (c) => {
  const db = c.get("db");
  const siteId = c.req.param("siteId");

  const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
  if (!site) return c.json({ error: "Site not found" }, 404);

  const [publications, domains] = await Promise.all([
    db.query.sitePublications.findMany({
      where: eq(sitePublications.siteId, siteId),
      orderBy: desc(sitePublications.createdAt),
      with: { crawl: true },
    }),
    db.query.siteDomains.findMany({
      where: eq(siteDomains.siteId, siteId),
      orderBy: desc(siteDomains.createdAt),
      with: { activePublication: true },
    }),
  ]);

  return c.json({
    cnameTarget: getHostingCnameTarget(c),
    settings: {
      hostingAutoPublish: site.hostingAutoPublish ?? true,
      hostingBillingEmail: site.hostingBillingEmail,
      hostingPaymentLinkUrl: site.hostingPaymentLinkUrl,
      hostingBillingStatus: site.hostingBillingStatus ?? "not_sent",
    },
    publications,
    domains,
  });
});

app.patch("/:siteId/hosting", zValidator("json", updateHostingSettingsSchema), async (c) => {
  const db = c.get("db");
  const siteId = c.req.param("siteId");
  const data = c.req.valid("json");

  const [site] = await db
    .update(sites)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(sites.id, siteId))
    .returning();

  if (!site) return c.json({ error: "Site not found" }, 404);

  return c.json({
    settings: {
      hostingAutoPublish: site.hostingAutoPublish ?? true,
      hostingBillingEmail: site.hostingBillingEmail,
      hostingPaymentLinkUrl: site.hostingPaymentLinkUrl,
      hostingBillingStatus: site.hostingBillingStatus ?? "not_sent",
    },
  });
});

app.post("/:siteId/publications", zValidator("json", createPublicationSchema), async (c) => {
  const db = c.get("db");
  const queue = c.get("queue");
  const siteId = c.req.param("siteId");
  const data = c.req.valid("json");

  const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
  if (!site) return c.json({ error: "Site not found" }, 404);

  const crawl = data.crawlId
    ? await db.query.crawls.findFirst({ where: and(eq(crawls.id, data.crawlId), eq(crawls.siteId, siteId)) })
    : await db.query.crawls.findFirst({
        where: and(eq(crawls.siteId, siteId), eq(crawls.status, "completed")),
        orderBy: desc(crawls.createdAt),
      });

  if (!crawl) return c.json({ error: "No completed crawl found for this site" }, 404);
  if (crawl.status !== "completed" || !crawl.outputPath) {
    return c.json({ error: "Only completed crawls with ZIP output can be published" }, 400);
  }

  const publicationId = crypto.randomUUID();
  const r2Prefix = `published/${siteId}/${publicationId}`;
  const [publication] = await db
    .insert(sitePublications)
    .values({ id: publicationId, siteId, crawlId: crawl.id, status: "pending", r2Prefix })
    .returning();

  try {
    await queue.addPublicationJob(siteId, crawl.id, publication.id, data.activate, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown queue error";
    await db
      .update(sitePublications)
      .set({ status: "failed", errorMessage: `Failed to queue publication job: ${message}`, updatedAt: new Date() })
      .where(eq(sitePublications.id, publication.id));
    return c.json({ error: "Failed to queue publication job" }, 503);
  }

  return c.json({ publication }, 201);
});

app.post("/:siteId/domains", zValidator("json", createDomainSchema), async (c) => {
  const db = c.get("db");
  const siteId = c.req.param("siteId");
  const { hostname } = c.req.valid("json");
  const cnameTarget = getHostingCnameTarget(c);

  const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
  if (!site) return c.json({ error: "Site not found" }, 404);
  if (hostname === cnameTarget || hostname.endsWith(`.${cnameTarget}`)) {
    return c.json({ error: "Use a client-owned hostname, not the hosting target domain" }, 400);
  }

  const cloudflareConfig = getCloudflareConfig(c);
  if (!cloudflareConfig) {
    return c.json({ error: "Cloudflare custom hostname configuration is required to add client domains" }, 503);
  }

  let cloudflareFields: ReturnType<typeof extractCloudflareDomainFields>;
  try {
    const result = await createCloudflareCustomHostname(c, hostname);
    if (!result) {
      return c.json({ error: "Cloudflare custom hostname provisioning is not configured" }, 503);
    }
    cloudflareFields = extractCloudflareDomainFields(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to provision Cloudflare custom hostname";
    return c.json({ error: message }, 502);
  }

  const latestPublication = await db.query.sitePublications.findFirst({
    where: and(eq(sitePublications.siteId, siteId), eq(sitePublications.status, "published")),
    orderBy: desc(sitePublications.createdAt),
  });

  try {
    const [domain] = await db
      .insert(siteDomains)
      .values({
        siteId,
        hostname,
        cnameTarget,
        status: cloudflareFields?.status ?? "pending_dns",
        activePublicationId: latestPublication?.id ?? null,
        redirectTargetOrigin: toOrigin(site.url),
        cloudflareHostnameId: cloudflareFields?.cloudflareHostnameId,
        ownershipVerificationName: cloudflareFields?.ownershipVerificationName,
        ownershipVerificationValue: cloudflareFields?.ownershipVerificationValue,
        sslStatus: cloudflareFields?.sslStatus,
      })
      .returning();

    return c.json({ domain }, 201);
  } catch (error) {
    return c.json({ error: "Hostname is already configured" }, 409);
  }
});

app.patch("/:siteId/domains/:domainId", zValidator("json", updateDomainSchema), async (c) => {
  const db = c.get("db");
  const siteId = c.req.param("siteId");
  const domainId = c.req.param("domainId");
  const data = c.req.valid("json");

  const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
  if (!site) return c.json({ error: "Site not found" }, 404);

  const redirectTargetOrigin =
    "redirectTargetOrigin" in data ? toOrigin(data.redirectTargetOrigin) : undefined;
  if (data.redirectTargetOrigin && !redirectTargetOrigin) {
    return c.json({ error: "Redirect target must be a valid URL origin" }, 400);
  }

  const [domain] = await db
    .update(siteDomains)
    .set({
      ...(typeof data.redirectEnabled === "boolean" ? { redirectEnabled: data.redirectEnabled } : {}),
      ...(redirectTargetOrigin !== undefined ? { redirectTargetOrigin } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(siteDomains.id, domainId), eq(siteDomains.siteId, siteId)))
    .returning();

  if (!domain) return c.json({ error: "Domain not found" }, 404);
  return c.json({ domain });
});

app.post("/:siteId/domains/:domainId/sync", async (c) => {
  const db = c.get("db");
  const siteId = c.req.param("siteId");
  const domainId = c.req.param("domainId");

  const domain = await db.query.siteDomains.findFirst({
    where: and(eq(siteDomains.id, domainId), eq(siteDomains.siteId, siteId)),
  });
  if (!domain) return c.json({ error: "Domain not found" }, 404);
  if (!domain.cloudflareHostnameId) return c.json({ domain });

  const result = await syncCloudflareCustomHostname(c, domain.cloudflareHostnameId);
  const fields = extractCloudflareDomainFields(result);
  const [updated] = await db
    .update(siteDomains)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(siteDomains.id, domain.id))
    .returning();

  return c.json({ domain: updated });
});

app.post("/:siteId/domains/:domainId/activate", zValidator("json", activatePublicationSchema), async (c) => {
  const db = c.get("db");
  const siteId = c.req.param("siteId");
  const domainId = c.req.param("domainId");
  const { publicationId } = c.req.valid("json");

  const publication = await db.query.sitePublications.findFirst({
    where: and(eq(sitePublications.id, publicationId), eq(sitePublications.siteId, siteId)),
  });
  if (!publication || publication.status !== "published") {
    return c.json({ error: "Published version not found" }, 404);
  }

  const [domain] = await db
    .update(siteDomains)
    .set({ activePublicationId: publicationId, updatedAt: new Date() })
    .where(and(eq(siteDomains.id, domainId), eq(siteDomains.siteId, siteId)))
    .returning();

  if (!domain) return c.json({ error: "Domain not found" }, 404);

  await db
    .update(sites)
    .set({ hostingAutoPublish: false, updatedAt: new Date() })
    .where(eq(sites.id, siteId));

  return c.json({ domain });
});

app.post("/:siteId/publications/:publicationId/activate", async (c) => {
  const db = c.get("db");
  const siteId = c.req.param("siteId");
  const publicationId = c.req.param("publicationId");

  const publication = await db.query.sitePublications.findFirst({
    where: and(eq(sitePublications.id, publicationId), eq(sitePublications.siteId, siteId)),
  });
  if (!publication || publication.status !== "published") {
    return c.json({ error: "Published version not found" }, 404);
  }

  await db
    .update(siteDomains)
    .set({ activePublicationId: publicationId, updatedAt: new Date() })
    .where(eq(siteDomains.siteId, siteId));

  await db
    .update(sites)
    .set({ hostingAutoPublish: false, updatedAt: new Date() })
    .where(eq(sites.id, siteId));

  return c.json({ publication });
});

app.delete("/:siteId/domains/:domainId", async (c) => {
  const db = c.get("db");
  const siteId = c.req.param("siteId");
  const domainId = c.req.param("domainId");

  const existing = await db.query.siteDomains.findFirst({
    where: and(eq(siteDomains.id, domainId), eq(siteDomains.siteId, siteId)),
  });
  if (!existing) return c.json({ error: "Domain not found" }, 404);

  if (existing.cloudflareHostnameId) {
    await deleteCloudflareCustomHostname(c, existing.cloudflareHostnameId);
  }

  await db.delete(siteDomains).where(and(eq(siteDomains.id, domainId), eq(siteDomains.siteId, siteId)));
  return c.json({ success: true });
});

export const hostingRoutes = app;
