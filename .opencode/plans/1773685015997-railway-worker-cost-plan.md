# Railway Worker Cost + Memory Optimization Plan

## Goal

Reduce Railway spend as aggressively as possible without reintroducing worker crashes on large crawls.

Primary goals:
- cut always-on worker cost
- stop single-crawl OOM crashes
- make worker sizing predictable enough to safely reduce CPU and memory limits

## Current Findings

### Railway

- Worker weekly average usage is tiny relative to provisioned size: about `0.016 CPU` and `1.87 GB` RAM.
- Worker weekly peak hit the full configured limit: about `32 GB` RAM and `2.35 CPU`.
- Worker memory ramped from about `3.7 GB` to `32 GB` over ~53 minutes on `2026-03-16`, then reset immediately after container restart. This strongly indicates an OOM or runaway memory accumulation.
- Worker env already runs only one crawl job at a time: `WORKER_CRAWL_CONCURRENCY=1`.
- Worker env still allows one crawl to fan out to `MAX_CRAWL_CONCURRENCY=10` and `MAX_SITE_CONCURRENCY=5`.
- Deployment metadata still shows a worker deployment with `3` replicas, while environment config now shows `1`. This drift must be resolved first because it can dominate cost.
- `api` and `web` are also provisioned much larger than their observed usage.

### Code Hotspots

- `packages/scraper/src/asset-downloader.ts`
  - binary assets are loaded fully into memory via `res.arrayBuffer()` then wrapped in `Buffer`
  - direct-path downloads do the same thing
- `packages/scraper/src/url-rewriter.ts`
  - many asset rewrite phases use broad `Promise.all(...)` fanout per page
- `packages/scraper/src/page-processor.ts`
  - dynamic-page asset downloads are collected into another broad `Promise.all(...)`
- `services/worker/src/processor.ts`
  - archives are zipped at zlib level `9`, which is CPU-expensive and unnecessary for cost optimization
- `packages/scraper/src/crawler.ts`
  - concurrency sizing still relies on optimistic heuristics instead of actual process/container memory
- Default site concurrency is inconsistent:
  - `services/worker/src/db.ts` says `30`
  - `packages/db/src/schema.ts` says `5`

## Cost-First Strategy

1. Eliminate waste from provisioning drift and oversized limits.
2. Remove the largest in-process memory spikes so the worker no longer needs a `32 GB` safety net.
3. Lower CPU-heavy archive work.
4. Add enough telemetry to downsize aggressively with confidence.

## Target End State

### Worker

- `1` replica
- short term after first code pass: `4 vCPU / 8-12 GB`
- follow-up target after validation: `2 vCPU / 4-8 GB`
- `WORKER_CRAWL_CONCURRENCY=1`
- `MAX_SITE_CONCURRENCY=3` or `4`
- `MAX_CRAWL_CONCURRENCY=4`

### API / Web

- shrink after worker work is deployed and confirmed stable
- likely targets:
  - `api`: `1-2 vCPU / 1-2 GB`
  - `web`: `1 vCPU / 1 GB`

## Build-Agent TODOs

### Phase 0 - Stop Obvious Cost Waste First

- [ ] Verify the live worker really runs with `1` replica in Railway.
- [ ] If any worker deployment still runs `3` replicas, force it down to `1`.
- [ ] Reduce worker CPU limit from `32` to `4` immediately.
- [ ] Keep worker memory at `32 GB` until the first code pass lands; do not reduce memory first.
- [ ] Lower worker runtime envs now:
  - [ ] set `MAX_SITE_CONCURRENCY=3`
  - [ ] set `MAX_CRAWL_CONCURRENCY=4`
- [ ] Enable `ASSET_CACHE_ENABLED=true` for repeat-crawl savings.

### Phase 1 - Remove the Biggest Memory Spikes

#### 1. Stream binary assets to disk instead of buffering

Files:
- `packages/scraper/src/asset-downloader.ts`

Tasks:
- [ ] Add a helper that streams `Response.body` directly to a file path.
- [ ] Replace binary asset download paths that currently use `Buffer.from(await res.arrayBuffer())`.
- [ ] Replace `downloadAssetToPath()` buffering with streaming writes.
- [ ] Keep CSS/JS text flows as text for rewrite support.
- [ ] Preserve abort behavior and fetch timeout behavior.
- [ ] Add tests that prove large binary assets are written without array-buffer buffering.

Expected impact:
- biggest reduction in memory spikes during image/media-heavy crawls
- direct cost benefit because it makes lower RAM limits feasible

#### 2. Bound per-page asset fanout with `p-limit`

Files:
- `packages/scraper/src/url-rewriter.ts`
- `packages/scraper/src/page-processor.ts`

Tasks:
- [ ] Introduce a shared bounded-concurrency helper using the existing `p-limit` dependency.
- [ ] Replace broad `Promise.all(...)` fanout in rewrite phases with bounded execution.
- [ ] Apply limits to:
  - [ ] stylesheets
  - [ ] scripts
  - [ ] images and `srcset`
  - [ ] media
  - [ ] icons
  - [ ] meta images
  - [ ] iframes
  - [ ] inline styles
  - [ ] code-island mirroring
- [ ] Replace dynamic page `downloadPromises` fanout in `page-processor.ts` with bounded execution.
- [ ] Add env vars with conservative defaults, for example:
  - [ ] `CRAWL_ASSET_CONCURRENCY=6`
  - [ ] `CRAWL_PAGE_ASSET_CONCURRENCY=6`
- [ ] Add tests for helper behavior and one integration test covering rewritten assets under bounded concurrency.

Expected impact:
- smoother memory usage within a single crawl
- lower burst network pressure
- fewer cases where one large page forces oversized containers

#### 3. Add large-asset protection

Files:
- `packages/scraper/src/asset-downloader.ts`
- optionally `packages/scraper/src/types.ts` if surfacing results

Tasks:
- [ ] Add optional HEAD/content-length checks for binary/media assets.
- [ ] Add env guards such as:
  - [ ] `CRAWL_MAX_BINARY_ASSET_BYTES`
  - [ ] `CRAWL_MAX_MEDIA_ASSET_BYTES`
- [ ] Skip or warn on extremely large files rather than trying to mirror them blindly.
- [ ] Make the skip behavior visible in logs.
- [ ] Add tests for skip behavior when content length exceeds configured limits.

Expected impact:
- prevents a few pathological assets from forcing huge memory, bandwidth, and storage costs

### Phase 2 - Make Archive/Upload Cheaper

#### 4. Lower archive compression cost now

Files:
- `services/worker/src/processor.ts`

Tasks:
- [ ] Make ZIP compression level configurable, defaulting to `1` or `3` instead of `9`.
- [ ] Add env var: `ARCHIVE_ZLIB_LEVEL`.
- [ ] Update progress/log messages if needed to mention configured archive mode.
- [ ] Add a small test around archive option plumbing if practical.

Expected impact:
- lower CPU time during archive creation
- lower Railway cost for a phase that currently does not need max compression

#### 5. Split crawl from archive/upload

Files:
- `services/worker/src/processor.ts`
- queue-related files under `apps/api/src/queue` and worker queue wiring if needed

Tasks:
- [ ] Design a second BullMQ job for archive/upload so crawling and zipping do not share the same process phase.
- [ ] Persist crawl output state so archive work can resume independently.
- [ ] Ensure completed crawls can move into an `archiving` or `uploading` state cleanly.
- [ ] Preserve current retry/orphan-recovery semantics.
- [ ] Only perform this after Phase 1 unless Phase 1 does not reduce peaks enough.

Expected impact:
- best longer-term path to reducing worker RAM further
- makes it possible to run crawl workers and archive workers at different sizes

### Phase 3 - Add Telemetry So Limits Can Drop Safely

#### 6. Add phase-level memory instrumentation

Files:
- `services/worker/src/processor.ts`
- `packages/scraper/src/crawler.ts`

Tasks:
- [ ] Add a small memory logger helper using `process.memoryUsage()`.
- [ ] Log `rss`, `heapUsed`, `external`, and `arrayBuffers`.
- [ ] Emit memory snapshots at:
  - [ ] crawl start
  - [ ] after sitemap resolution
  - [ ] before browser launch
  - [ ] every N pages during crawl
  - [ ] before archive
  - [ ] after archive
  - [ ] after upload
  - [ ] on failure
- [ ] Track peak RSS per crawl and store it in logs.
- [ ] Make logging frequency configurable to avoid excessive log volume.

Expected impact:
- enables confident downsizing from `32 GB`
- helps separate crawl leaks from archive/upload leaks

#### 7. Use container-aware memory budgeting instead of optimistic heuristics

Files:
- `packages/scraper/src/crawler.ts`

Tasks:
- [ ] Read cgroup/container memory limit when available instead of relying only on `os.freemem()`.
- [ ] Base concurrency decisions on process RSS plus remaining container budget.
- [ ] Add a hard safety ceiling that clamps effective concurrency when RSS crosses a threshold.
- [ ] Keep env overrides available for debugging but not as the default operating mode.
- [ ] Add unit tests for the sizing helper.

Expected impact:
- avoids picking concurrency that looks safe to the host but is unsafe inside Railway containers

### Phase 4 - Clean Up Config and Defaults

#### 8. Unify concurrency defaults and docs

Files:
- `services/worker/src/db.ts`
- `packages/db/src/schema.ts`
- `SETUP-INFRASTRUCTURE.md`

Tasks:
- [ ] Pick one default site concurrency and use it everywhere.
- [ ] Recommended default: `5` at the schema level, with runtime caps lower in production via env.
- [ ] Update docs so runtime defaults match code.
- [ ] Document all new env vars introduced in Phases 1-3.

Expected impact:
- less accidental over-provisioning from hidden defaults

## Deployment Sequence

### Deploy 1 - Cheapest safe savings

- [ ] Reduce worker replicas to `1`.
- [ ] Reduce worker CPU to `4`.
- [ ] Set `MAX_SITE_CONCURRENCY=3`.
- [ ] Set `MAX_CRAWL_CONCURRENCY=4`.
- [ ] Enable `ASSET_CACHE_ENABLED=true`.

### Deploy 2 - Memory spike reduction

- [ ] Ship streaming binary downloads.
- [ ] Ship bounded asset concurrency.
- [ ] Ship large-asset guards.
- [ ] Observe three large crawls.

### Deploy 3 - Cost reduction pass

- [ ] Lower worker memory from `32 GB` to `12 GB`.
- [ ] If stable, lower again to `8 GB`.
- [ ] If peak CPU remains well below `4`, lower worker CPU to `2`.

### Deploy 4 - Archive optimization

- [ ] Lower ZIP compression level.
- [ ] If still needed, split archive/upload into its own job or service.

### Deploy 5 - Right-size the rest

- [ ] Reduce `api` limits.
- [ ] Reduce `web` limits.

## Acceptance Criteria

- worker completes your largest recurring crawls without container restarts
- worker weekly average usage stays well below provisioned limits
- worker peak memory stays below `8 GB` on known large crawls after Phase 1 and Phase 2
- Railway worker spend is materially lower because the service can run at `1 replica` and much smaller CPU/RAM limits
- no regression in crawl completeness for normal Webflow sites

## Verification Checklist

- [ ] run `bun test packages/scraper/src`
- [ ] run `bun run lint`
- [ ] run one small crawl, one medium crawl, and one of the largest known problem crawls
- [ ] compare output completeness before vs after for at least one dynamic site and one static-heavy site
- [ ] verify logs include memory snapshots and any large-asset skips
- [ ] inspect Railway metrics 24h and 7d after deploy

## Recommended First Build Slice

If only one implementation slice is funded now, do this exact bundle first:

1. stream binary asset downloads to disk
2. bound asset rewrite/download concurrency with `p-limit`
3. lower archive compression level
4. add phase-level memory logging
5. reduce worker to `1 replica`, `4 vCPU`, keep memory high until telemetry confirms lower limits

This slice has the best odds of producing immediate cost savings while also eliminating the memory blowups that currently force oversized Railway limits.
