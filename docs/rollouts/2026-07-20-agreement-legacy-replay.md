# Agreement backlog: legacy-replay fallback for exhausted-attempt docs

Date: 2026-07-20. Seat: CLAUDE. Branch: `claude/agreement-legacy-replay`, off `origin/main` `41d4563b`.

## The bug

Live D1 query at time of diagnosis: 592 filings sit unresolved in `review_queue`
with `reason='agreement_cascade_unresolved'`, `agreement_attempts=3` (== the
default `AGREEMENT_MAX_ATTEMPTS` cap), oldest since 2026-07-12, essentially zero
drain over the prior 24h.

The backlog autopilot (`app/src/extraction/autopilot.ts`) was already running
hourly and correctly reporting `backlog_before: 592` (`countEligibleBacklog`
counts `resolved=0 AND suppressed IS NULL AND raw_object_key IS NOT NULL`, with
no attempts filter). But every single run showed `docs_attempted: 0` and
`halt_reason: "backlog_drained"` — a self-contradictory receipt.

Root cause: `selectNextDoc`'s `ELIGIBLE_PREDICATES` requires
`COALESCE(agreement_attempts, 0) < ?` (the attempt cap), which correctly
prevents the per-minute cron and the autopilot from burning unlimited spend on
a doc that already exhausted its budget — but it also means once a doc hits
the cap, it becomes **permanently invisible** to every selection path with no
mechanism to ever look at it again. `backlog_before` (uncapped count) and
`selectNextDoc` (capped selection) measure different things, so the autopilot
kept declaring an unchanged 592-doc backlog "drained."

All 592 carry the benign `agreement_cascade_unresolved` reason (models
genuinely disagreed across the full tiered cascade, including several already
at tier 2) — never a hard-fail/corrupt/quarantine classification. Several
model-catalog and configuration fixes have landed since these were created
(the dead-Gemini incident fix, the OpenRouter-only migration, the benchmark
model-config redesign — all 07-15 through 07-17), so a fresh attempt is
genuinely likely to behave differently than it did on 07-12.

## The fix

Additive, default-off. No schema migration — `agreement_legacy_replay_at`
already existed in the live D1 schema and in `AgreementReviewState`
(`app/src/extraction/agreement.ts`) but had no reader/writer anywhere in the
codebase; this fix is the first thing that uses it, as the exactly-once grace
marker it was clearly designed for.

- New knob `AUTOPILOT_LEGACY_REPLAY_ENABLED` (default `false`).
- `selectNextDoc` falls back to `selectLegacyReplayDoc` **only** when (a) the
  knob is on and (b) the normal `attempts < cap` pool is empty for this
  selection — it never displaces a normally-eligible doc.
- `selectLegacyReplayDoc` selects one doc with `attempts >= cap AND
  reason='agreement_cascade_unresolved' AND legacy_replay_at IS NULL`, then
  atomically resets it (`attempts=0, tier=NULL, next_attempt_at=NULL`) and
  stamps `legacy_replay_at=now()` in a single guarded `UPDATE ... WHERE
  legacy_replay_at IS NULL` (checked via `meta.changes`) — the same CAS
  pattern `acquireAgreementLease`/`reserveLlmBudget` already use elsewhere in
  this cascade. A concurrent selector that loses the race gets `null` back
  and the tick correctly treats the pool as empty rather than double-granting
  a reset.
- Once reset, the doc flows through the **exact same, unmodified**
  `handleAgreementCheck` cascade as any other doc: same leases, same fresh
  3-attempt budget, same daily LLM budget guardrail, same error-class
  kill-switch, same unanimity/majority publish rules, same spend meter. This
  grants exactly one additional full attempt budget — never a bypass of any
  existing governance — and `legacy_replay_at` guarantees it happens at most
  once per doc, so a doc that fails again after the fresh budget becomes
  terminal for good.
- Surfaced in `getAutopilotStatus`'s knobs summary.

## Why default-off

Matches the repo's established pattern for anything that changes spend
behavior (see `autopilot.ts`'s own "OWNER POLICY" docstring: pilot-sized runs,
no-retry-burn, error-class kill-switch, halt-requires-acknowledgment). Flipping
`AUTOPILOT_LEGACY_REPLAY_ENABLED=true` is a deliberate owner action; until then
this PR is a behavior-identical no-op — the exact same as every autopilot run
today, unchanged.

## Verification

- `npx tsc --noEmit`: clean.
- `app/src/extraction/__tests__/autopilot.test.ts`: added 4 tests — default-off
  no-op (byte-identical to current behavior), enabled-fallback selects/resets/
  runs the cascade, never displaces a normal doc, and a lost reset race is
  handled cleanly (no double-grant, no crash).
- Full `npm test` run pending in CI.

## Scope

`app/src/extraction/autopilot.ts` + its test file only. Does not touch
`agreement.ts`'s cascade logic, `senateSource.ts`/`watcher.ts` (AG's active
Senate-hardening area), `app/src/delivery/`, `app/src/client/`, or the #620
resource-governor files (`deadLetter.ts`/`outbox.ts`/`webhook.ts`/
`targetCircuit.ts`).
