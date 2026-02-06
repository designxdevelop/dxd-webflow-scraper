# Infrastructure Setup Guide

All code changes are complete. This document covers the manual infrastructure provisioning and deployment steps needed to go live.

## Architecture Overview

```
                 +-----------------------+
                 |  Cloudflare Workers   |
                 |  (API - Hono)         |
                 |                       |
                 |  R2 bindings          |
                 |  Hyperdrive -> PG     |
                 |  Upstash Redis HTTP   |
                 +----------+------------+
                            |
              HTTP enqueue  |  SSE polling
                            v
                 +-----------------------+
                 |  Railway (Worker)     |
                 |  BullMQ + Playwright  |
                 |  ioredis (TCP)        |
                 |  S3 SDK -> R2         |
                 +-----------------------+
                            |
              ioredis TCP   |  S3-compat API
                            v
         +-------------+  +----------------+
         | Upstash     |  | Cloudflare R2  |
         | Redis       |  | (storage)      |
         +-------------+  +----------------+
                            |
              Hyperdrive    |
                            v
                 +-----------------------+
                 |  Railway PostgreSQL   |
                 +-----------------------+
```

---

## Step 1: Reuse Existing Cloudflare R2 Bucket

Since you're already using R2, reuse the existing bucket.

1. Go to **Cloudflare Dashboard > R2 Object Storage**
2. Confirm the bucket name currently used by your worker
3. Generate/confirm an **S3-compatible API token** with read/write access to that bucket
4. Note the **Account ID**, **Access Key ID**, **Secret Access Key**

The R2 S3-compatible endpoint is:
```
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

---

## Step 2: Create Upstash Redis Instance

1. Go to **https://console.upstash.com** and create a new Redis database
2. Note the following values:
   - **REST URL** (for Workers API): `https://XXXX.upstash.io`
   - **REST Token** (for Workers API)
   - **Redis URL** (for worker service): `rediss://default:XXXX@XXXX.upstash.io:6379`

Both the Workers API (HTTP) and the Railway worker (TCP/ioredis) connect to the **same** Upstash Redis instance via different protocols.

---

## Step 3: Create Cloudflare Hyperdrive Configuration

Hyperdrive proxies your Railway PostgreSQL for connection pooling from Workers.

```bash
# From the apps/api directory
npx wrangler hyperdrive create dxd-postgres \
  --connection-string="postgres://USER:PASSWORD@HOST:PORT/DATABASE"
```

Note the **Hyperdrive Config ID** from the output. Update `apps/api/wrangler.toml`:
```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "YOUR_HYPERDRIVE_CONFIG_ID"
```

---

## Step 4: Optional Data Migration (Only if needed)

If your existing crawler data is already in R2, skip this step.

If you still have crawl data in AWS S3 that must be kept, sync it to R2:

```bash
# Install rclone if needed
brew install rclone

# Configure rclone with both S3 and R2 remotes, then sync
rclone sync s3:your-bucket-name r2:dxd-storage --progress
```

**Then update the Railway worker's environment variables** to point at R2's S3-compatible API:

| Variable | Value |
|----------|-------|
| `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `S3_ACCESS_KEY_ID` | R2 API token access key |
| `S3_SECRET_ACCESS_KEY` | R2 API token secret key |
| `S3_BUCKET` | `dxd-storage` |
| `S3_REGION` | `auto` |
| `S3_FORCE_PATH_STYLE` | `true` |

The worker writes via S3 protocol; the Workers API reads via native R2 bindings. Same bucket.

---

## Step 5: Set Cloudflare Workers Secrets

```bash
cd apps/api

# Auth
wrangler secret put AUTH_SECRET
wrangler secret put AUTH_URL          # e.g. https://api.yourdomain.com
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET

# Upstash Redis (HTTP endpoint for Workers)
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN

# Worker service (Railway internal URL)
wrangler secret put WORKER_SERVICE_URL    # e.g. https://your-worker.up.railway.app
wrangler secret put WORKER_API_SECRET     # generate a random secret
```

---

## Step 6: Update Railway Worker Environment

Add these new variables to the worker service on Railway:

| Variable | Value |
|----------|-------|
| `REDIS_URL` | Upstash Redis TCP URL: `rediss://default:XXXX@XXXX.upstash.io:6379` |
| `WORKER_HTTP_PORT` | `3002` (or whatever port Railway exposes) |
| `WORKER_API_SECRET` | Same secret you set in Step 5 |

The worker now runs both the BullMQ processor and an HTTP server for receiving enqueue requests from the Workers API.

**Important:** Expose the worker's HTTP port in Railway so the Workers API can reach it. The URL should be the value you set for `WORKER_SERVICE_URL` in Step 5.

---

## Step 7: Update GitHub OAuth Callback URL

Your GitHub OAuth app's callback URL needs to point to the Workers API domain:

1. Go to **GitHub > Settings > Developer Settings > OAuth Apps**
2. Update the **Authorization callback URL** to:
   ```
   https://api.yourdomain.com/api/auth/callback/github
   ```

---

## Step 8: Deploy Workers API

```bash
cd apps/api

# Test locally first
wrangler dev

# Deploy to production
wrangler deploy
```

---

## Step 9: DNS Configuration

If your API is at `api.yourdomain.com`, configure DNS:

**Option A: Custom domain in wrangler.toml**
Add to `apps/api/wrangler.toml`:
```toml
routes = [
  { pattern = "api.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

**Option B: Workers route in Cloudflare dashboard**
Go to your domain's Workers Routes and add:
- Route: `api.yourdomain.com/*`
- Worker: `dxd-api`

---

## Step 10: Cutover Checklist

- [ ] Existing R2 bucket verified (and data sync done only if needed)
- [ ] Upstash Redis created
- [ ] Hyperdrive config ID added to `wrangler.toml`
- [ ] All secrets set via `wrangler secret put`
- [ ] Worker service updated with R2 S3 endpoint and `WORKER_API_SECRET`
- [ ] Worker HTTP port exposed on Railway
- [ ] GitHub OAuth callback URL updated
- [ ] `wrangler deploy` succeeds
- [ ] DNS points to Workers
- [ ] Test: OAuth login flow works
- [ ] Test: Create a crawl, verify it runs and SSE events arrive
- [ ] Test: Preview an archived site
- [ ] Test: Download a zip archive
- [ ] Keep old Railway API running for 48-72h as hot standby
- [ ] Tear down old Railway API after stabilization

---

## Rollback

If anything goes wrong:
1. Revert DNS to point back to Railway API
2. The Railway API still works against the same Postgres and Redis
3. No data is lost — R2 and Postgres are the same for both runtimes

---

## New Environment Variables Reference

### Workers API (Cloudflare)

Set via `wrangler.toml` [vars]:
- `NODE_ENV` — `production`
- `FRONTEND_URL` — Frontend app URL
- `CORS_ALLOWED_ORIGINS` — Comma-separated extra origins

Set via `wrangler secret put`:
- `AUTH_SECRET` — Auth.js secret
- `AUTH_URL` — API base URL
- `GITHUB_CLIENT_ID` — GitHub OAuth client ID
- `GITHUB_CLIENT_SECRET` — GitHub OAuth client secret
- `UPSTASH_REDIS_REST_URL` — Upstash HTTP endpoint
- `UPSTASH_REDIS_REST_TOKEN` — Upstash HTTP token
- `WORKER_SERVICE_URL` — Railway worker HTTP URL
- `WORKER_API_SECRET` — Shared auth secret for worker HTTP API

Bindings (in wrangler.toml):
- `STORAGE_BUCKET` — R2 bucket binding
- `HYPERDRIVE` — Hyperdrive binding to Railway Postgres

### Worker Service (Railway)

- `DATABASE_URL` — PostgreSQL connection string (unchanged)
- `REDIS_URL` — Upstash Redis TCP URL (was local/Railway Redis)
- `WORKER_HTTP_PORT` — Port for HTTP API server (default: 3002)
- `WORKER_API_SECRET` — Shared auth secret
- `S3_ENDPOINT` — R2 S3-compatible endpoint (was AWS S3)
- `S3_ACCESS_KEY_ID` — R2 API token access key
- `S3_SECRET_ACCESS_KEY` — R2 API token secret key
- `S3_BUCKET` — `dxd-storage`
- `S3_REGION` — `auto`

### Scraper Tuning (Optional)

- `CRAWL_PAGE_MAX_RETRIES` — Max retries per page (default: 2)
- `CRAWL_PAGE_RETRY_DELAY_MS` — Base delay for retry backoff (default: 2000)
- `MAX_CRAWL_CONCURRENCY` — Max concurrent pages across all browsers (default: 10)
