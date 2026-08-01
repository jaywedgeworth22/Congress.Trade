# 2026-08-01 — DLQ recovery diagnosis + durable failed-job requeue + extraction catch-up

## Summary

Follow-up to the July-28 transaction-import freeze (filings detected but zero
new `transactions` rows since 2026-07-28 21:49 UTC).

**Diagnosis (prod evidence):**

1. The DLQ replay bug that produced 195 `ingest DLQ message has no doc_id`
   terminal failures (July 30–31) was **already fixed in review batch-1**
   (`f685b6d4`, merged July 29). The old code threw for any dead-lettered
   ingest message that wasn't `filing.new`; the current
   `handleDeadLetterMessage` reconnects the ingestion outbox for all filing
   types. The July 30–31 failures were the pre-fix image draining its retry
   backlog; no such failures after July 31 06:15 UTC.
2. What remained: **467 `filing.extracted` jobs stuck in
   `deno_runtime_queue status='failed'`** (271 OpenRouter weekly-limit 403s
   from July 25 + 195 DLQ-replay casualties + 1 other) — their filings never
   extracted, and nothing would ever retry them.
3. Throughput: the `free` cost profile (2 jobs/15-min tick, a Deno Deploy
   free-tier artifact) would take weeks to drain the ~3,900-job backlog on
   the self-hosted Coolify/Oracle deployment where those quotas don't apply.

**Changes:**

- New `requeueFailedDurableJobs` (`app/src/deno/durableQueue.ts`): resets
  `failed` durable-queue rows to a fresh `pending` state (attempts/cycles/
  leases cleared), skipping rows whose dedupe key is held by an active
  sibling (would violate the active-dedupe unique index). Dry-run + type
  filter + limit; idempotent.
- New admin endpoint `POST /api/admin/queue-requeue-failed`
  (`{queue?, type?, limit?, dryRun?}`) — the durable-queue analogue of the
  existing `/ingest-requeue-failed` (which covers `ingestion_outbox`).
- Ops (no code): `CT_COST_PROFILE=balanced` set as a Coolify runtime env
  (2-min ticks, 8 jobs/tick ≈ 5.7k/day) so the requeue + backlog actually
  drains; `free` was sized for Deno Deploy free-tier quotas that are
  irrelevant on the Oracle host.

**Pre-requeue verification:** R2 storage smoke test passes (put/get/delete —
the owner re-minted the deleted R2 S3 token). OpenRouter weekly-limit 403s
were July-25-only; extraction succeeded July 26–28 and it's a new billing
week. Requeued jobs land in the idempotent `extractAndNormalize`
(`INSERT OR IGNORE` on `(doc_id, source, row_key)`), so double-processing is
safe.

## Files changed

- `app/src/deno/durableQueue.ts` — `requeueFailedDurableJobs` helper
- `app/src/deno/__tests__/durableQueue.test.ts` — 5 integration tests (in-memory SQLite)
- `app/src/admin/routes.ts` — `POST /api/admin/queue-requeue-failed`

## Verification

- `npm run typecheck` clean; `npm test` 1990/1990 green.
- Prod: `POST /api/admin/queue-requeue-failed {"type":"filing.extracted","limit":1000}`
  requeued 467 rows; drain on the balanced profile + transaction creation
  monitored via `SELECT MAX(created_at) FROM transactions`.

## Follow-ups

- The ~973 `filing.new` + ~2,438 `usage.telemetry` backlog drains over the
  next day on the balanced profile; July 30–31 filings extract as their jobs
  reach the front.
- If OpenRouter 403s return, jobs retry with backoff and the (now fixed)
  DLQ path reconnects the outbox instead of dying terminally.
- Coolify auto-deploy webhook missed a main merge again (second time) —
  deploy was triggered manually via the Coolify API. Fleet should check the
  GitHub → Coolify webhook.
