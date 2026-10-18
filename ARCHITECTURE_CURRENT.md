# Current Architecture

This document reflects the active implementation as of 2026-10-18, after the move from Railway to Cloudflare and PlanetScale.

## Runtime Topology

- Web UI (`apps/web`): React SPA built with Vite + TanStack Router, served as static assets by the `dxd-archiver-web` Worker.
- API (`apps/api`): Hono app on the `dxd-archiver-api` Worker (Smart Placement). Exposes authenticated CRUD + crawl endpoints, runs the every-minute cron tick, and owns the `Crawler` container Durable Object.
- Crawler (`services/worker`): Playwright crawl process that runs in a Cloudflare Container. It claims `pending` rows from Postgres, processes them, and exits when there is nothing left to do.
- Hosting Worker (`apps/hosting-worker`): `dxd-backup-hosting`, serves published backups on client custom hostnames from R2.
- Shared packages:
  - `@dxd/db`: Drizzle schema + DB client shared by API and worker.
  - `@dxd/scraper`: crawl engine and HTML/asset rewrite pipeline.
  - `@dxd/storage`: local/S3/R2 storage adapters.

There is no Redis, no BullMQ and no always-on worker. Postgres is the queue.

## Infrastructure

Everything runs in the Cloudflare account "Design X Develop", except the database.

| Piece | Where it runs |
|-------|---------------|
| Web (`zip.designxdevelop.com`) | Worker `dxd-archiver-web`, via a Worker route on the proxied DNS record |
| API (`zip-api.designxdevelop.com`) | Worker `dxd-archiver-api`, via a Worker route on the proxied DNS record; Smart Placement |
| Crawler | Cloudflare Container, class `Crawler`, `instance_type` `standard-1`, `max_instances` 1. Started on demand ("Run now") and by the API cron tick; scales to zero when idle |
| Hosted backups | Worker `dxd-backup-hosting` |
| Storage | R2 bucket `dxd-site-scraper` |
| Database | PlanetScale Postgres (below) |

Database:

- PlanetScale org `designxdevelop-llc`, cluster `dxd-apps` (PS-5 single node, Postgres 18, AWS us-east-1, host `us-east-3.pg.psdb.cloud`), logical database `archiver`.
- The cluster is shared with other apps. PS-5 allows only 25 direct connections across all of them, so keep pools small.
- The API and hosting Workers connect through Hyperdrive `dxd-site-archiver-db` (`c0bd95a95ffc438aa3ebb25f8766b6a5`), which points at PlanetScale's PgBouncer on port 6432 with an origin connection limit of 5.
- Containers can't use Hyperdrive bindings, so the crawler connects with its own `CRAWLER_DATABASE_URL` (a Worker secret) and a 2-connection pool (`services/worker/src/db.ts`).
- Credentials are in the 1Password vault "DXD Production": "PlanetScale dxd-apps - archiver admin" and "PlanetScale dxd-apps - archiver app". Never write them into files.
- Backups: PlanetScale automatic backups every 12 h kept for 2 days, plus a daily backup kept for 30 days.

Railway is no longer used. The Railway project was deleted on 2026-10-18.

## Data Flow

1. UI calls API (`/api/sites`, `/api/crawls`, `/api/settings`).
2. API writes DB records (`status = 'pending'`) and wakes the crawler container via `QueueClient`.
3. Every minute the API cron tick (`apps/api/src/scheduler.ts`) creates crawls for due schedules and wakes the container if any work is outstanding.
4. The crawler claims rows with `FOR UPDATE SKIP LOCKED`, writes progress and logs to the DB, streams archives to R2, and publishes hosted backups.
5. The UI polls `GET /api/crawls/:id` for live progress and logs.
6. Completed archives are served via the API download endpoint; published backups are served by the hosting Worker.

## Shared Contracts

- DB schema lives in `packages/db/src/schema.ts` and is imported by both services.
- Queue contract (insert a `pending` row, then wake the container) lives in `apps/api/src/queue/client.ts`.
- Scraper output and progress types live in `packages/scraper/src/types.ts`.

## Verification

- Local: `bun run verify`
- CI: `.github/workflows/CI.yml` runs the same verify command on PRs/pushes.
