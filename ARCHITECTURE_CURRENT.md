# Current Architecture

This document reflects the active implementation as of 2026.

## Runtime Topology

- Web UI (`apps/web`): React SPA built with Vite + TanStack Router.
- API (`apps/api`): Hono service exposing authenticated CRUD + crawl endpoints.
- Worker (`services/worker`): BullMQ consumer for crawl/schedule/upload pipelines.
- Shared packages:
  - `@dxd/db`: Drizzle schema + DB client shared by API and worker.
  - `@dxd/scraper`: crawl engine and HTML/asset rewrite pipeline.
  - `@dxd/storage`: local/S3/R2 storage adapters.

## Data Flow

1. UI calls API (`/api/sites`, `/api/crawls`, `/api/settings`).
2. API writes DB records and enqueues jobs via queue abstraction.
3. Worker processes crawl jobs, publishes progress/logs, and uploads archives.
4. API streams live updates over SSE (`/api/sse/crawls/:id`).
5. Completed archives are served via API download endpoint.

## Shared Contracts

- DB schema lives in `packages/db/src/schema.ts` and is imported by both services.
- Queue and pub/sub contracts live in `apps/api/src/queue/client.ts`.
- Scraper output and progress types live in `packages/scraper/src/types.ts`.

## Verification

- Local: `bun run verify`
- CI: `.github/workflows/ci.yml` runs the same verify command on PRs/pushes.
