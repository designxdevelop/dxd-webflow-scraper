# Agent Instructions

This repository is optimized for AI coding agents (Codex, Claude Code, Cursor, Copilot).

## Project Map

- `apps/api`: Hono API service (Node runtime + Workers entrypoint)
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
- Add tests for bugfixes and for non-trivial route/util behavior.

## Key Runtime Boundaries

- API enqueues jobs through `QueueClient` abstraction (`apps/api/src/queue/client.ts`).
- Worker owns crawl execution state machine (`services/worker/src/processor.ts`).
- SSE stream for live crawl updates is exposed at `GET /api/sse/crawls/:id`.

## High-Risk Areas (read before editing)

- `services/worker/src/processor.ts`: long-running job lifecycle, retries, upload transitions.
- `packages/scraper/src/page-processor.ts`: static-vs-playwright path decisions.
- `packages/storage/src/s3.ts`: multipart upload and retry behavior.
