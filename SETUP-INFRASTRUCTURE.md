# Infrastructure Setup Guide

This document covers the infrastructure provisioning and deployment steps for the current architecture.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Railway Project                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │   Web UI     │   │    API       │   │    Worker    │    │
│  │  (Vite SPA)  │   │  (Hono/Node) │   │  (BullMQ)    │    │
│  │              │   │              │   │  Playwright  │    │
│  └──────────────┘   └──────────────┘   └──────────────┘    │
│         │                  │                  │             │
│         └──────────────────┼──────────────────┘             │
│                            │                                 │
│  ┌──────────────┐         │                                 │
│  │  PostgreSQL  │         │                                 │
│  │              │◄────────┘                                 │
│  └──────────────┘                                           │
│                            │                                 │
│  ┌──────────────┐         │                                 │
│  │    Redis     │◄────────┘                                 │
│  │  (BullMQ)    │                                           │
│  └──────────────┘                                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                           │
               S3-compatible API
                           ▼
                  ┌─────────────────┐
                  │  Cloudflare R2  │
                  │  (archives +    │
                  │   published)    │
                  └─────────────────┘
                           ▲
                           │
                  ┌─────────────────┐
                  │ Hosting Worker  │
                  │ (Cloudflare)    │
                  │ Custom hostnames│
                  └─────────────────┘
```

## Step 1: Railway Project Setup

Create a Railway project with these services:

1. **PostgreSQL** — add via Railway template
2. **Redis** — add via Railway template (or use Upstash/Redis Cloud)
3. **Web** — deploy from your repo, root directory `apps/web`
4. **API** — deploy from your repo, root directory `apps/api`
5. **Worker** — deploy from your repo, root directory `services/worker`

## Step 2: Cloudflare R2 Bucket

1. Go to **Cloudflare Dashboard > R2 Object Storage**
2. Create or reuse a bucket (e.g. `dxd-site-scraper`)
3. Generate an **S3-compatible API token** with read/write access
4. Note the **Account ID**, **Access Key ID**, **Secret Access Key**

The R2 S3-compatible endpoint is:
```
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

## Step 3: Deploy Services to Railway

### API Environment Variables

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `FRONTEND_URL` | Your web app URL |
| `AUTH_SECRET` | Random secret for Auth.js |
| `AUTH_URL` | API base URL |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `HOSTING_CNAME_TARGET` | Client CNAME target hostname |
| `CLOUDFLARE_ZONE_ID` | Zone for custom hostnames |
| `CLOUDFLARE_API_TOKEN` | Token for custom hostname management |
| `R2_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret key |
| `R2_BUCKET` | `dxd-site-scraper` |
| `R2_REGION` | `auto` |
| `R2_FORCE_PATH_STYLE` | `true` |

### Web Environment Variables

| Variable | Value |
|----------|-------|
| `PORT` | `3000` (or whatever Railway assigns) |
| `NODE_ENV` | `production` |

### Worker Environment Variables

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Same PostgreSQL connection string |
| `REDIS_URL` | Same Redis connection string |
| `WORKER_HTTP_PORT` | `3002` (or Railway assigned port) |
| `WORKER_API_SECRET` | Shared secret for worker HTTP API |
| `HOSTING_CNAME_TARGET` | Same as API |
| `CLOUDFLARE_ZONE_ID` | Same as API |
| `CLOUDFLARE_API_TOKEN` | Same as API |
| `R2_ENDPOINT` | Same as API |
| `R2_ACCESS_KEY_ID` | Same as API |
| `R2_SECRET_ACCESS_KEY` | Same as API |
| `R2_BUCKET` | Same as API |
| `R2_REGION` | Same as API |
| `R2_FORCE_PATH_STYLE` | `true` |

The worker runs both the BullMQ processor and an HTTP server for receiving enqueue requests from the API.

**Important:** Expose the worker's HTTP port in Railway so the API can reach it.

## Step 4: Deploy Hosting Worker to Cloudflare

The hosting worker (`apps/hosting-worker`) serves published backup sites via custom hostnames.

1. Create a **Hyperdrive** config pointing to your Railway PostgreSQL:
```bash
cd apps/hosting-worker
bunx wrangler hyperdrive create dxd-postgres \
  --connection-string="postgres://USER:PASSWORD@HOST:PORT/DATABASE"
```

2. Update `apps/hosting-worker/wrangler.toml` with the Hyperdrive config ID.

3. Deploy:
```bash
cd apps/hosting-worker
bunx wrangler deploy
```

4. Configure a **Cloudflare for SaaS** fallback origin pointing to your hosting worker domain.

## Step 5: DNS & GitHub OAuth

1. Point your API domain to the Railway API service
2. Point your web domain to the Railway web service
3. Update your **GitHub OAuth app** callback URL to:
   ```
   https://api.yourdomain.com/api/auth/callback/github
   ```

## Step 6: Database Migrations

```bash
bun run db:migrate
```

## Cutover Checklist

- [ ] Railway PostgreSQL running
- [ ] Railway Redis running
- [ ] R2 bucket created with API token
- [ ] API service deployed with all env vars
- [ ] Web service deployed
- [ ] Worker service deployed with all env vars
- [ ] Worker HTTP port exposed and reachable from API
- [ ] Hosting Worker deployed to Cloudflare
- [ ] Hyperdrive config created and working
- [ ] GitHub OAuth callback URL updated
- [ ] DNS pointing to Railway services
- [ ] Test: OAuth login works
- [ ] Test: Create a crawl, verify it runs and SSE events arrive
- [ ] Test: Download a ZIP archive
- [ ] Test: Publish a completed crawl
- [ ] Test: Add a client CNAME hostname

## Rollback

If anything goes wrong, all services run on Railway with the same Postgres and Redis. Revert DNS or Railway service redeployment. No external dependencies other than R2 (which is just storage).

## Environment Variables Reference

### API Service (Railway)

- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
- `FRONTEND_URL` — Web app URL
- `CORS_ALLOWED_ORIGINS` — Comma-separated extra origins
- `AUTH_SECRET` — Auth.js secret
- `AUTH_URL` — API base URL
- `GITHUB_CLIENT_ID` — GitHub OAuth client ID
- `GITHUB_CLIENT_SECRET` — GitHub OAuth client secret
- `HOSTING_CNAME_TARGET` — Client CNAME target hostname
- `CLOUDFLARE_ZONE_ID` — Zone for custom hostnames
- `CLOUDFLARE_API_TOKEN` — Token for custom hostname management
- `R2_*` — R2 storage credentials

### Web Service (Railway)

- `PORT` — Server port
- `NODE_ENV` — `production`

### Worker Service (Railway)

- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
- `WORKER_HTTP_PORT` — HTTP API port
- `WORKER_API_SECRET` — Shared auth secret
- `HOSTING_CNAME_TARGET` — Same as API
- `CLOUDFLARE_ZONE_ID` — Same as API
- `CLOUDFLARE_API_TOKEN` — Same as API
- `R2_*` — Same R2 credentials as API

### Hosting Worker (Cloudflare)

- `HYPERDRIVE` — Hyperdrive binding to Railway Postgres
- `STORAGE_BUCKET` — R2 bucket binding

## Local Development

```bash
# Start dependencies
docker-compose up -d

# Install dependencies
bun install

# Run migrations
bun run db:migrate

# Start API
bun run start:api

# Start web (separate terminal)
bun run start:web

# Start worker (separate terminal)
bun run start:worker
```
