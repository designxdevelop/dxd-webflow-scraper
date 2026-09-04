# Agent Instructions

## Project Map

- `apps/api`: Hono API service (Node runtime)
- `apps/web`: Vite + React + TanStack Router dashboard
- `services/worker`: BullMQ worker for crawl execution and scheduling
- `packages/scraper`: Shared crawling and rewrite engine
- `packages/storage`: Shared storage adapters (local, S3, R2)
- `packages/db`: Shared Drizzle schema + DB client

## Fast Verification

- Run `bun run verify` from repo root before committing.
- `verify` includes:
  - `bun run lint` (workspace type checks)
  - `bun test` (all tests)

## Development Conventions

- Keep route logic in `apps/api/src/routes` thin; move reusable logic into `*.utils.ts` next to routes.
- Prefer shared packages for cross-service contracts (`@dxd/db`, `@dxd/storage`, `@dxd/scraper`).
- Avoid duplicating schema or protocol definitions between API and worker.
- Verify behavior with the relevant test coverage; add a focused test when the changed behavior is not covered.

## Key Runtime Boundaries

- API enqueues jobs through `QueueClient` abstraction (`apps/api/src/queue/client.ts`).
- Worker owns crawl execution state machine (`services/worker/src/processor.ts`).
- SSE stream for live crawl updates is exposed at `GET /api/sse/crawls/:id`.

## Crawl and upload lifecycle

- Before changing crawl execution, rendering-path selection, multipart upload, or retries, inspect `services/worker/src/processor.ts`, `packages/scraper/src/page-processor.ts`, and `packages/storage/src/s3.ts`.
