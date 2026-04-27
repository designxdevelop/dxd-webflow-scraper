# Backup Hosting Setup

This guide covers the infrastructure required for client-owned CNAME backup hosting.

The intended model is:

```txt
Internal dashboard: https://zip.designxdevelop.com
Client visible backup URL: https://backup.client.com
Client DNS: backup.client.com CNAME backup-hosting.designxdevelop.com
Cloudflare Worker: serves R2 backup or 301 redirects to the client root domain
```

Clients should not use a `designxdevelop.com` URL directly. Your hostname is only the CNAME target.

## Architecture

```txt
Client browser
  -> backup.client.com
  -> CNAME backup-hosting.designxdevelop.com
  -> Cloudflare Custom Hostname / Worker
  -> Postgres hostname lookup
  -> R2 published backup files
```

When the backup is not needed, the Worker can return a permanent redirect:

```txt
https://backup.client.com/about?x=1
  301 -> https://client.com/about?x=1
```

When the backup is needed, disable redirect mode for that client domain and the Worker serves the static backup from R2.

## Required Cloudflare Resources

You need these Cloudflare pieces:

- R2 bucket used by the scraper archives and hosted backup files.
- Hyperdrive config pointing to Railway Postgres.
- Dedicated Cloudflare Worker from `apps/hosting-worker`.
- Cloudflare for SaaS / Custom Hostnames configured for client-owned CNAME hostnames.
- Cloudflare API token that can manage custom hostnames in the `designxdevelop.com` zone.

## Recommended Hostnames

Use:

```txt
zip.designxdevelop.com
```

for the internal dashboard.

Use:

```txt
backup-hosting.designxdevelop.com
```

as the CNAME target clients point to.

Client DNS example:

```txt
Type: CNAME
Name: backup
Target: backup-hosting.designxdevelop.com
```

This produces:

```txt
backup.client.com -> backup-hosting.designxdevelop.com
```

## Cloudflare R2

Use the same R2 bucket that archives are already uploaded to.

In `apps/hosting-worker/wrangler.toml`:

```toml
[[r2_buckets]]
binding = "STORAGE_BUCKET"
bucket_name = "dxd-site-scraper"
```

If your bucket has a different name, replace `dxd-site-scraper` with the real bucket name.

## Cloudflare Hyperdrive

The hosting Worker needs Postgres access to map incoming hostnames to the active published backup.

Create a Hyperdrive config pointing to Railway Postgres:

```bash
cd apps/hosting-worker
bunx wrangler hyperdrive create dxd-postgres \
  --connection-string="postgres://USER:PASSWORD@HOST:PORT/DATABASE"
```

Then update `apps/hosting-worker/wrangler.toml`:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "YOUR_HYPERDRIVE_CONFIG_ID"
```

The API Worker config, if used, also needs the same Hyperdrive ID in `apps/api/wrangler.toml`.

## Deploy The Hosting Worker

Deploy the dedicated hosting Worker:

```bash
cd apps/hosting-worker
bun install
bunx wrangler deploy
```

The Worker name is configured as:

```toml
name = "dxd-backup-hosting"
```

## Configure The Hosting Target Route

In Cloudflare, route this hostname to the hosting Worker:

```txt
backup-hosting.designxdevelop.com/* -> dxd-backup-hosting
```

You can do that through either:

- Cloudflare Worker custom domains.
- A Workers route in the `designxdevelop.com` zone.

## Configure Cloudflare For SaaS / Custom Hostnames

In the `designxdevelop.com` Cloudflare zone:

1. Enable/configure Cloudflare for SaaS / Custom Hostnames.
1. Set the fallback origin/target to:

```txt
backup-hosting.designxdevelop.com
```

1. Ensure custom hostnames can be created for client domains like:

```txt
backup.client.com
```

When a domain is added in the dashboard, the API creates a Cloudflare custom hostname. Cloudflare may return TXT verification records. The dashboard displays those records so you can send them to the client.

## Cloudflare API Token

Create a Cloudflare API token scoped to the `designxdevelop.com` zone.

It needs permission to manage custom hostnames for that zone.

Set these variables in Railway:

```txt
CLOUDFLARE_ZONE_ID=<designxdevelop.com zone id>
CLOUDFLARE_API_TOKEN=<custom-hostname management token>
```

## Railway Environment Variables

Set these on the Railway app/API service that powers `https://zip.designxdevelop.com`:

```txt
FRONTEND_URL=https://zip.designxdevelop.com
HOSTING_CNAME_TARGET=backup-hosting.designxdevelop.com
CLOUDFLARE_ZONE_ID=<designxdevelop.com zone id>
CLOUDFLARE_API_TOKEN=<custom-hostname management token>
```

Keep the existing database, queue, auth, and storage values.

Typical required values:

```txt
DATABASE_URL=<Railway Postgres URL>
REDIS_URL=<Redis URL>
WORKER_SERVICE_URL=<Railway worker HTTP URL>
WORKER_API_SECRET=<shared secret>
```

For R2 storage, use whichever env family your app already uses successfully.

R2-style example:

```txt
STORAGE_TYPE=r2
R2_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<R2 access key>
R2_SECRET_ACCESS_KEY=<R2 secret>
R2_BUCKET=dxd-site-scraper
R2_REGION=auto
R2_FORCE_PATH_STYLE=true
```

S3-compatible example:

```txt
STORAGE_TYPE=s3
S3_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<R2 access key>
S3_SECRET_ACCESS_KEY=<R2 secret>
S3_BUCKET=dxd-site-scraper
S3_REGION=auto
S3_FORCE_PATH_STYLE=true
```

The Railway worker must use the same R2 bucket as the hosting Worker.

## Run Database Migrations

After merging and deploying the code, run:

```bash
bun run db:migrate
```

This applies:

```txt
0003_add_static_hosting.sql
0004_add_hosting_controls_and_billing.sql
0005_add_hosting_redirect_mode.sql
```

These migrations add:

- Published backup records.
- Client hostname records.
- Auto-publish settings.
- Billing link fields.
- Redirect mode fields.

## Client Domain Setup Flow

For each client:

1. Open the site in the internal dashboard.
1. Add their backup hostname, for example:

```txt
backup.client.com
```

1. Give the client this CNAME instruction:

```txt
backup.client.com CNAME backup-hosting.designxdevelop.com
```

1. If Cloudflare returns TXT verification records, give those to the client too.
1. Click `Sync` in the dashboard until Cloudflare/SSL status becomes active.
1. Publish a completed crawl or wait for the next successful crawl to auto-publish.

## Operating Modes

Each client hostname has two modes.

### Redirect Mode

Use this when the client's main site is healthy.

Behavior:

```txt
backup.client.com/* 301 -> client.com/*
```

The redirect preserves path and query string.

Example:

```txt
https://backup.client.com/services/web-design?utm=test
  -> https://client.com/services/web-design?utm=test
```

### Backup Mode

Use this during extended downtime of the client's main site.

Behavior:

```txt
backup.client.com/* -> static backup files from R2
```

Disable redirect mode in the dashboard to serve the backup.

## Version Behavior

By default:

```txt
latest successful crawl auto-publishes as the live backup
```

For rollback/pinning:

1. Select an older published version in the dashboard.
2. Activate it.
3. Auto-publish is disabled so the hosted backup stays pinned.

To resume latest-successful behavior, re-enable `Auto latest`.

## Billing Workflow

This is intentionally internal and simple for now.

1. Create a monthly Stripe Payment Link manually in Stripe.
2. Paste it into the site's billing field in the dashboard.
3. Add the client's billing email.
4. Click `Send Link`.

The dashboard tracks billing status manually:

```txt
not_sent
sent
paid
past_due
cancelled
```

If billing needs to become automatic later, add Stripe Checkout/Billing webhooks to update this status.

## Smoke Test Checklist

- `bun run db:migrate` succeeds.
- `apps/hosting-worker` deploys successfully.
- `backup-hosting.designxdevelop.com` reaches the hosting Worker.
- Adding `backup.client.com` in the dashboard creates a Cloudflare custom hostname.
- Client CNAME points to `backup-hosting.designxdevelop.com`.
- Dashboard `Sync` eventually shows active SSL/domain status.
- Publishing a crawl creates files under `published/<siteId>/<publicationId>/` in R2.
- With redirect disabled, `backup.client.com` serves the backup.
- With redirect enabled, `backup.client.com/path?x=1` returns `301` to the configured root origin with `/path?x=1` preserved.
