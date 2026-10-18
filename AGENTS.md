# Agent Instructions

## Project Map

- `apps/api`: Hono API on Cloudflare Workers (Hyperdrive, R2); also hosts the `Crawler` container Durable Object and the cron scheduler
- `apps/web`: Vite + React + TanStack Router dashboard (Workers static assets)
- `services/worker`: crawler process run in a Cloudflare Container; drains `status = 'pending'` rows from Postgres, then exits
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

- Postgres is the queue. API inserts `pending` rows and wakes the container via `QueueClient` (`apps/api/src/queue/client.ts`).
- Worker owns crawl execution state machine (`services/worker/src/processor.ts`).
- Live crawl view polls `GET /api/crawls/:id` (logs/progress persisted in the DB). No Redis.
- Production: Cloudflare Workers + a scale-to-zero Container, R2, and PlanetScale Postgres (shared `dxd-apps` cluster, 25 direct connections total; Workers use Hyperdrive, the container a 2-connection pool). Details in `ARCHITECTURE_CURRENT.md`. Railway is gone.

## Crawl and upload lifecycle

- Before changing crawl execution, rendering-path selection, multipart upload, or retries, inspect `services/worker/src/processor.ts`, `packages/scraper/src/page-processor.ts`, and `packages/storage/src/s3.ts`.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
