# 2026-09-09 — Time-box the Deno cron tick's upstream calls (CONGRESS-TRADE-1B)

Board `c630ceed`.  Branch `claude/tick-deadline-1b`.  Lane
`~/apps/congress-claude-tick-deadline-1b`.  Sentry `CONGRESS-TRADE-1B`.

## Summary

`Error: Deno cron tick exceeded 45000ms deadline` has fired 622 times since
2026-08-21 and was still firing on the day this lane opened.  It was set to
`archived_forever` in Sentry rather than fixed, so it produced no alert and did
not appear in any `is:unresolved` sweep — it recurred silently.

The tick was already built to be time-boxed.  `src/deno/main.ts` soft-aborts an
`AbortController` five seconds before the hard deadline, and
`runMaintenancePipeline` checks that signal between lanes so the pipeline stops
at a boundary rather than being abandoned.  The bug was that the two latency
lanes did not participate in any of it:

- `runDisclosureLatencyProbe` and `runLatencyPriceSnapshotTick` were handed the
  bare global `fetch`.  Deno's `fetch` has no default timeout, so a single slow
  peer response had no bound at all.
- `runLatencyPriceSnapshotTick` was not given the tick's signal.  Its backfill
  branch makes **one serial peer call per (ticker, trading day) group**, up to a
  `CAPTURE_BATCH` of 50 rows, so a full batch is dozens of round trips that ran
  to completion no matter how late the tick was.

The latest event's breadcrumbs show exactly that: after
`latency probe: server holds fmp at high cadence`, a serial run of
`GET https://socratictrade.com/api/market/intraday/<SYMBOL>` calls at roughly
350–650 ms each, still going at 20:45:44 when the deadline threw at 20:45:45 —
four seconds *after* the soft abort had already fired at 20:45:40 and been
ignored.  The same tickers appear twice with different ranges, which is a
previous tick's lane still running: `Promise.race` had rejected that tick, but
nothing cancelled its work.  Each abandoned run then competed with the next
tick for the same peer, making the next one slower — a feedback loop, not a
one-off slow tick.

## Files changed

- `app/src/shared/deadlineFetch.ts` (new) — `createDeadlineFetch`,
  `resolveUpstreamTimeoutMs`, `DEFAULT_TICK_FETCH_TIMEOUT_MS`
- `app/src/deno/scheduledTick.ts` — build the deadline-bound fetch once per
  pipeline run and give it to both latency lanes; pass the tick signal into the
  snapshot lane; new `upstreamTimeoutMs` option
- `app/src/deno/main.ts` — derive `upstreamTimeoutMs` from the tick deadline
- `app/src/ingestion/latencyPriceSnapshots.ts` — cooperative cancellation at
  candidate and backfill-group boundaries; `aborted` on the result
- `app/src/shared/__tests__/deadlineFetch.test.ts` (new)
- `app/src/ingestion/__tests__/latencyPriceSnapshots.test.ts` — time-boxing cases
- `app/src/deno/__tests__/scheduledTick.test.ts` — wiring cases
- `docs/EFFORT-LOG.md`, this note

## Changes

1. **Every upstream call inside the tick gets its own deadline.**
   `createDeadlineFetch` wraps a `fetch` so each request carries a timeout and
   dies with the caller's abort signal.  The timeout deliberately is not
   cleared when `fetch()` resolves: it covers the response body too, because a
   peer that answers `200` and then stalls mid-body hangs a time-boxed tick
   exactly as badly as one that never answers.  A call attempted after the
   outer signal has already fired rejects without opening a socket, so an
   aborted tick stops costing the peer traffic immediately.
2. **The per-call budget is derived from the deadline, not hard-coded.**
   `resolveUpstreamTimeoutMs(deadlineMs)` returns ten seconds at the default
   45,000 ms and caps at a quarter of the deadline below that, so the invariant
   "one upstream call cannot consume the run" holds at every setting
   `CT_TICK_DEADLINE_MS` allows (its floor is 10,000 ms, where a flat ten-second
   budget would have been the whole tick).
3. **The snapshot lane stops at a boundary and carries the rest forward.**
   `scheduleMissingLatencyPriceSnapshots` checks between candidates;
   `captureDueLatencyPriceSnapshots` checks before the live branch and between
   backfill groups.  Whatever was captured before the stop is still flushed, so
   the tick is incremental rather than merely interrupted.  Nothing has to be
   carried by hand: a row that was not reached keeps `captured_at IS NULL`, so
   the next tick's due query selects it again.  That is also why stopping early
   is free of correctness cost — there is no partial state to reconcile.

## The 45,000 ms constant is unchanged, deliberately

It is not arbitrary, so the "raise it only if the code shows it is arbitrary"
condition is not met:

- `main.ts` documents its provenance (Deno Deploy free-tier heritage) and it is
  already operator-tunable — `CT_TICK_DEADLINE_MS`, clamped to 10,000 ms …
  14 minutes, which the Oracle container already raises for bigger drain
  batches.
- The heavy daily work was deliberately moved *out* of this tick into the
  staggered lane crons in `deno/cronLanes.ts`, each with its own multi-minute
  deadline, precisely so the tick stays short.  Raising it would walk that back.
- Raising it would not have fixed this.  The overrun was unbounded work with
  unbounded upstream calls; a larger number just moves the overrun and gives the
  abandoned-request pileup more room to grow.

## Verification

- `cd app && npm run typecheck` (`deno check src/deno/main.ts`) — clean.
- `cd app && npx vitest run src/shared/__tests__/deadlineFetch.test.ts
  src/ingestion/__tests__/latencyPriceSnapshots.test.ts
  src/deno/__tests__/scheduledTick.test.ts` — all green.
- `deno lint` on the changed files reports the same pre-existing findings as
  `main`; the new module adds none.
- Sentry `CONGRESS-TRADE-1B` moved from `archived_forever` back to
  `unresolved`, so a recurrence alerts instead of being swallowed.

## Follow-ups

- The other lanes that reach off-box (`agreement_autopublish`,
  `backlog_autopilot`, `apns_fanout`) still take no signal.  They were not the
  lanes in the failing breadcrumbs and were left alone here rather than widened
  into an unverified refactor.
- Worth watching whether `CAPTURE_BATCH` of 50 is still the right batch now
  that a late batch stops cleanly instead of overrunning.
