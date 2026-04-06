# Crawl Filename And Stale Recovery Design

## Summary

Fix two related production issues in the crawl worker:

1. Asset downloads can generate filesystem paths that exceed Linux filename limits, crashing the worker with `ENAMETOOLONG`.
2. Crashed crawls can appear stuck for too long because healthy and unhealthy jobs currently share the same long lock window, and lock renewal is disabled.

The selected approach is to keep the existing queue and orphan-reconciliation model, but make it safer:

- cap generated asset filenames so local writes always stay within filename limits
- re-enable BullMQ lock renewal for healthy jobs
- reduce stale-job recovery timing from the current hour-scale behavior to a 10 minute window

## Goals

- Prevent `ENAMETOOLONG` crashes during crawl asset writes.
- Preserve deterministic asset naming for normal-length filenames.
- Let healthy long-running crawl and archive jobs continue without being reclaimed as stale.
- Recover crashed or dead worker jobs noticeably faster.
- Add targeted regression coverage for both the filename logic and the stale-job configuration defaults.

## Non-Goals

- Replacing BullMQ with a different queueing model.
- Reworking crawl progress persistence or SSE delivery.
- Introducing a new heartbeat table or lease protocol in the database.
- Changing archive file naming or download URLs.

## Current Problem

### Asset filename crash

`packages/scraper/src/asset-downloader.ts` builds most asset filenames from:

- a slugified basename derived from the remote URL path
- a short SHA-1 suffix for deduplication
- the chosen file extension

This works for typical assets, but some remote image paths contain extremely long basename segments. After slugification, the generated local filename can exceed the filesystem's per-path-component limit, causing `fs.writeFile()` to fail with `ENAMETOOLONG` and terminate the worker.

### Slow stale recovery

`services/worker/src/processor.ts` currently configures long lock durations and disables lock renewal with `skipLockRenewal: true`. That means:

- healthy long-running jobs survive only because the lock window is very large
- crashed jobs can remain effectively stuck until that large lock window expires
- orphan reconciliation sees an old active crawl, but queue-level recovery is delayed by the stale lock timing

The observed production behavior is roughly one hour of "stuck" state after worker death, which is too slow.

## Proposed Changes

### 1. Cap generated asset filenames

Update the asset path generation helper in `packages/scraper/src/asset-downloader.ts` so that non-chunk asset filenames are bounded before writing to disk.

Rules:

- Keep the current chunk-file exception for runtime chunk names that must remain exact.
- Keep the current directory layout (`images/`, `js/`, `css/`, etc.).
- Keep the hash suffix for deduplication.
- If the slugified basename would push the filename over the maximum safe component length, truncate only the basename portion.
- Preserve the extension.

Target behavior:

- ordinary assets keep their current readable names
- extremely long basenames are shortened deterministically
- the final filename always fits within a conservative local filesystem component limit

Implementation note:

- Introduce a small filename helper that computes the maximum basename budget after accounting for `-<hash><ext>`.
- Use a conservative constant, e.g. 180-200 characters, rather than trying to consume the full theoretical 255-byte limit. This keeps room for future differences in encoding and avoids edge-case regressions.

### 2. Re-enable lock renewal for healthy jobs

Update the BullMQ worker configuration in `services/worker/src/processor.ts`:

- remove `skipLockRenewal: true` for both crawl and archive workers
- reduce the default `WORKER_LOCK_DURATION_MS` to 10 minutes
- keep orphan reconciliation enabled as the fallback path after crashes or restarts

Why this is the chosen behavior:

- healthy jobs should renew their lock and remain owned while they are making progress
- crashed jobs should stop renewing and become recoverable much sooner
- the existing orphan reconciliation loop already handles the "worker died mid-job" case well enough for this scope

### 3. Keep stale recovery aligned with the new target

Align default recovery-related timing so the system consistently reflects the chosen 10 minute window.

Expected defaults:

- `WORKER_LOCK_DURATION_MS`: 10 minutes
- `ORPHAN_CRAWL_GRACE_MS`: 10 minutes

Guiding rule:

- stale detection should not fire before a healthy job has had a fair chance to renew its lock
- stale detection also should not lag far behind lock expiry, otherwise the UI still appears hung

## Error Handling

- Filename truncation is preventive, so no new runtime error path is expected for long asset names.
- If a chunk filename is itself too long and must remain exact, the existing error should still surface. This is acceptable for now because chunk assets are a compatibility-sensitive special case and the observed crash came from image asset naming.
- If a worker crashes, the job should become reclaimable after the shorter lock window instead of lingering for about an hour.

## Testing Plan

### Asset downloader tests

Add regression tests around the filename builder in `packages/scraper` that verify:

- normal asset URLs still produce readable slug-plus-hash filenames
- an extremely long image URL produces a truncated filename that remains within the configured safe length
- the truncated filename still preserves the extension and hash suffix
- chunk filenames continue to be preserved exactly

### Worker configuration tests

Add focused tests in `services/worker` for the configuration parsing / worker setup behavior that verify:

- the default lock duration is 10 minutes
- workers no longer opt out of lock renewal
- any exposed stale-grace default stays aligned with the selected recovery window

If direct worker-construction tests are awkward, extract the relevant configuration assembly into a small pure helper and test that helper instead.

## Verification

Before calling the fix complete:

- run the new targeted tests first
- run the relevant worker/scraper test suites if they exist nearby
- run the repo verification command if the change remains clean and time allows

## Risks And Mitigations

### Risk: false stale recovery for very long but healthy jobs

Mitigation:

- re-enable lock renewal so healthy jobs keep ownership even when runtime exceeds 10 minutes
- keep orphan reconciliation as a backup, not the primary mechanism for healthy jobs

### Risk: changed filenames affect rewrite references

Mitigation:

- preserve the current slug-plus-hash format for ordinary assets
- only truncate the basename portion when necessary
- preserve extensions and chunk special-casing

### Risk: test coverage misses the exact production shape

Mitigation:

- use a regression test with a realistically oversized image basename similar to the production failure pattern

## Rollout

1. Add failing regression tests for the filename overflow case and the worker config defaults.
2. Implement the bounded filename helper and worker config updates.
3. Re-run targeted tests, then broader verification.
4. Redeploy the worker so new lock behavior takes effect.
