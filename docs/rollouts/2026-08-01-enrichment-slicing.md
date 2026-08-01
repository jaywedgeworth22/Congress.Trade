# 2026-08-01 — Enrichment time-slicing + hourly drain lane

## Summary

Follow-up to `2026-07-31-cron-lane-split.md`. The first night on staggered
lanes proved the remaining bottleneck: the `daily-market-data` lane aborted
at its 600s deadline because serial, provider-paced enrichment needed
~20–30 min for the backlog, starving price refresh / peer share / freshness
behind it. The abort also only *detached* the lane promise (work continued
untracked) because no AbortSignal was threaded into the lanes.

Changes:

- **Enrichment is time-sliced.** `runEnrichment` accepts `signal` +
  `deadlineMs` and stops picking up new candidates at the boundary. Work is
  persisted per candidate, so a partial slice resumes cleanly next run.
- **Daily market-data lane can no longer starve.** Its enrichment pass is
  capped at 4 minutes; price refresh, peer share, telemetry, and the
  freshness watchdog always run every day.
- **New `hourly-enrichment` lane (:47 UTC).** No daily date stamp — the
  daily FMP call cap and the un-enriched candidate predicates self-limit
  spend. 1,200-candidate / 8-minute slices drain the backlog through the
  day instead of one midnight marathon. The 20% price-refresh budget floor
  applies only until price refresh has run that day (lane-stamp check);
  each slice's fresh refs are shared to the peer (delta only).
- **Deadlines actually stop work now.** `runDailyLane` threads its
  AbortSignal into lane `run()` functions.

## Files changed

- `app/src/enrichment/service.ts` — `signal` / `deadlineMs` opts.
- `app/src/jobs.ts` — time-sliced daily lane; `runHourlyEnrichmentSlice`
  (+ `HOURLY_ENRICHMENT_SLICE_MAX`, `HOURLY_ENRICHMENT_SLICE_DEADLINE_MS`).
- `app/src/deno/cronLanes.ts` — 5th lane, signal threading.
- Tests: slice cap/time-box, floor on vs off, no-budget early return,
  peer-share delta, no-stamp repeatability, 5-lane window policy,
  signal threading.

## Verification

- Gates: typecheck clean; `npm test` 1984/1984 (181 files). PR #1212.
- First-night baseline before this change (from prod logs):
  `daily lane daily-market-data aborted at deadline`,
  `bulk snapshot written: 2026-08-01 3348065 rows` (207s),
  `daily lane daily-filer ran in 1304ms`, `daily lane daily-retention ran`.
- Post-deploy expectation: `daily lane daily-market-data ran` (no abort),
  hourly `daily lane hourly-enrichment` lines while backlog remains, then
  cheap no-ops.

## Note

The deploy of this change coincided with a peer-driven docker data-root
migration on the Oracle host (docker masked, `/var/lib/docker` →
`/data/docker`; root disk had been at 88%). Prod was 521/502 during the
migration; deploy + final verification were completed after docker returned.
