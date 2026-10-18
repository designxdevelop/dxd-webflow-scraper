# Infrastructure Setup Guide

This document covers the infrastructure provisioning and deployment steps for the current architecture: Cloudflare Workers + a Cloudflare Container, R2, and PlanetScale Postgres. Railway is no longer used; the Railway project was deleted on 2026-10-18.

All Cloudflare resources live in the "Design X Develop" account.

## Architecture Overview

```
                 zip.designxdevelop.com          zip-api.designxdevelop.com
                 (Worker route)                  (Worker route)
                          │                               │
                 ┌────────▼────────┐             ┌────────▼────────┐
                 │ dxd-archiver-web│   fetch     │ dxd-archiver-api│  cron: every minute
                 │ (Vite SPA,      │────────────►│ (Hono, Smart    │
                 │  static assets) │             │  Placement)     │
                 └─────────────────┘             └──┬──────┬────┬──┘
                                       start / wake │      │    │ Hyperdrive
                                                    ▼      │    ▼ dxd-site-archiver-db
                                    ┌───────────────────┐  │  ┌──────────────────────────┐
                                    │ Crawler container │  │  │ PlanetScale Postgres     │
                                    │ (standard-1,      │──┼─►│ dxd-apps / archiver      │
                                    │  max 1, scales    │  │  │ (PgBouncer :6432)        │
                                    │  to zero)         │  │  └──────────────────────────┘
                                    └─────────┬─────────┘  │               ▲
                                              │ S3 API     │ R2 binding    │ Hyperdrive
                                              ▼            ▼               │
                                         ┌──────────────────────┐  ┌───────┴────────────┐
                                         │ R2: dxd-site-scraper │◄─│ dxd-backup-hosting │
                                         │ (archives+published) │  │ (client hostnames) │
                                         └──────────────────────┘  └────────────────────┘
```

There is no Redis and no always-on worker. Postgres rows with `status = 'pending'` are the queue.

## Step 1: PlanetScale Database

The database is already provisioned:

- Org `designxdevelop-llc`, cluster `dxd-apps` (PS-5 single node, Postgres 18, AWS us-east-1, host `us-east-3.pg.psdb.cloud`).
- Logical database `archiver`. The cluster is shared with other apps.
- Credentials: 1Password vault "DXD Production", items "PlanetScale dxd-apps - archiver admin" and "PlanetScale dxd-apps - archiver app". Never write credentials into files in this repo.
- Backups: automatic every 12 h kept for 2 days, plus a daily backup kept for 30 days.

Connection budget: PS-5 allows only 25 direct connections across all apps on the cluster. The Workers go through Hyperdrive (origin connection limit 5) and the crawler uses a 2-connection pool. Keep any new client equally small.

## Step 2: Cloudflare R2 Bucket

1. Go to **Cloudflare Dashboard > R2 Object Storage**
2. Create or reuse the bucket `dxd-site-scraper`
3. Generate an **S3-compatible API token** with read/write access (the crawler container uses the S3 API)
4. Note the **Account ID**, **Access Key ID**, **Secret Access Key**

The R2 S3-compatible endpoint is:
```
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

The API and hosting Workers use the R2 binding `STORAGE_BUCKET` instead of keys.

## Step 3: Hyperdrive

The API and hosting Workers share Hyperdrive config `dxd-site-archiver-db` (`c0bd95a95ffc438aa3ebb25f8766b6a5`), pointed at PlanetScale's PgBouncer on port 6432 with an origin connection limit of 5 and query caching disabled (the UI polls crawl status and must see fresh rows). If it ever needs to be recreated:

```bash
cd apps/api
bunx wrangler hyperdrive create dxd-site-archiver-db \
  --connection-string="postgres://USER:PASSWORD@us-east-3.pg.psdb.cloud:6432/archiver" \
  --origin-connection-limit=5 \
  --caching-disabled
```

Then update the `hyperdrive` id in both `apps/api/wrangler.jsonc` and `apps/hosting-worker/wrangler.toml`.

If the database moves, update the Hyperdrive origin and the `CRAWLER_DATABASE_URL` secret together.

## Step 4: Deploy the API Worker and Crawler Container

`apps/api/wrangler.jsonc` defines the `dxd-archiver-api` Worker, its route, the every-minute cron trigger, the Hyperdrive and R2 bindings, and the `Crawler` container (built from `services/worker/Dockerfile`, `instance_type` `standard-1`, `max_instances` 1). Non-secret settings are in `vars` there.

Set secrets with `wrangler secret put` in `apps/api`:

| Secret | Value |
|--------|-------|
| `AUTH_SECRET` | Random secret for Auth.js |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `CLOUDFLARE_ZONE_ID` | Zone for custom hostnames |
| `CLOUDFLARE_API_TOKEN` | Token for custom hostname management |
| `CRAWLER_DATABASE_URL` | Direct PlanetScale URL for the crawler container (containers can't use Hyperdrive) |
| `R2_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret key |
| `CRAWLER_TRIGGER_SECRET` | Optional bearer token for `POST /internal/crawler/kick` (smoke tests); unset disables the endpoint |

Deploy (Docker must be running locally to build the container image):

```bash
cd apps/api
bun run deploy
```

The API Worker starts the container on "Run now" and on each cron tick when work is pending. The container drains the queue and exits, so it scales to zero.

## Step 5: Deploy the Web Worker

```bash
cd apps/web
bun run deploy
```

This builds the SPA with `VITE_API_URL=https://zip-api.designxdevelop.com` and deploys `dxd-archiver-web`.

## Step 6: Deploy the Hosting Worker

The hosting worker (`apps/hosting-worker`, `dxd-backup-hosting`) serves published backup sites via custom hostnames. It uses the same R2 bucket and Hyperdrive config.

```bash
cd apps/hosting-worker
bunx wrangler deploy
```

Configure a **Cloudflare for SaaS** fallback origin pointing to the hosting worker domain. See `docs/setup-backup-hosting.md`.

## Step 7: DNS & GitHub OAuth

1. `zip.designxdevelop.com` and `zip-api.designxdevelop.com` are proxied DNS records; the Worker routes in `apps/web/wrangler.jsonc` and `apps/api/wrangler.jsonc` serve them.
2. The **GitHub OAuth app** callback URL is:
   ```
   https://zip-api.designxdevelop.com/api/auth/callback/github
   ```

## Step 8: Database Migrations

Run migrations from your machine against PlanetScale, with `DATABASE_URL` taken from 1Password (not saved to a file):

```bash
DATABASE_URL=<PlanetScale archiver URL> bun run db:migrate
```

## Verification Checklist

- [ ] PlanetScale `archiver` database reachable
- [ ] R2 bucket and API token in place
- [ ] Hyperdrive `dxd-site-archiver-db` pointed at PgBouncer (port 6432)
- [ ] API Worker deployed with all secrets
- [ ] Web Worker deployed
- [ ] Hosting Worker deployed
- [ ] GitHub OAuth callback URL updated
- [ ] Test: OAuth login works
- [ ] Test: Create a crawl, verify the container starts, and progress/logs appear in the crawl view
- [ ] Test: Download a ZIP archive
- [ ] Test: Publish a completed crawl
- [ ] Test: Add a client CNAME hostname

## Rollback

There is no fallback origin: Railway was deleted on 2026-10-18, so removing a Worker route would leave the hostname with nothing behind it. Roll back a bad deploy with `wrangler rollback` (or the Deployments tab) for the affected Worker. Restore data from PlanetScale backups if needed.

## Environment Variables Reference

### API Worker (`dxd-archiver-api`)

- Bindings: `HYPERDRIVE`, `STORAGE_BUCKET` (R2), `CRAWLER` (container Durable Object)
- Vars (`wrangler.jsonc`): `NODE_ENV`, `FRONTEND_URL`, `AUTH_URL`, `CORS_ALLOWED_ORIGINS`, `AUTH_COOKIE_DOMAIN`, `HOSTING_CNAME_TARGET`, `CRAWLER_OWNS_QUEUE`, plus crawler storage/tuning vars
- Secrets: see Step 4

### Crawler Container

- Gets `DATABASE_URL` (from `CRAWLER_DATABASE_URL`), `CRAWL_ID` (for "Run now"), `CRAWLER_OWNS_QUEUE`, and the API Worker's `STORAGE_TYPE`, `R2_*`, `AWS_*`, `CRAWL_*`, `ARCHIVE_*`, `ASSET_*` and `MAX_SITE_CONCURRENCY` values (see `apps/api/src/crawler.ts`)

### Web Worker (`dxd-archiver-web`)

- `VITE_API_URL` at build time

### Hosting Worker (`dxd-backup-hosting`)

- `HYPERDRIVE` — Hyperdrive binding (`dxd-site-archiver-db`) to PlanetScale
- `STORAGE_BUCKET` — R2 bucket binding

## Local Development

Local development uses a Docker Postgres instead of PlanetScale:

```bash
# Start local Postgres
docker-compose up -d

# Install dependencies
bun install

# Run migrations
DATABASE_URL=postgresql://dxd:dxd@localhost:5432/scraper bun run db:migrate

# Start API (wrangler dev) and web (vite)
bun run dev

# Run the crawler once: drains pending crawls/publications, then exits
cd services/worker
DATABASE_URL=postgresql://dxd:dxd@localhost:5432/scraper CRAWLER_OWNS_QUEUE=true bun run start
```

For `wrangler dev`, point the `HYPERDRIVE` binding at local Postgres with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://dxd:dxd@localhost:5432/scraper`.
