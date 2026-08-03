# 2026-08-02 — Scanned-PDF backlog cleared via local vision swarm (no OpenRouter)

## Summary

The 247-document scanned-PTR backlog (156 `error` + 63 `classified` + 22 that
classified during the work) was fully processed **without OpenRouter** by a
21-lane local subagent swarm that read the paper forms visually — paper PTR
type/amount are X-marks in a checkbox grid, which deterministic text OCR
cannot recover. All 247 filings are now `persisted` with
`extractor='local-vision-swarm-1'`; **0 scanned filings remain in
error/classified** and the 2026-07-25 extraction stall is fully cleared.

- **16,506 rows** transcribed to strict JSONL; mechanical validation: 0
  violations (schema, bracket↔amount consistency, tx_date ≤ filed_date).
- Visual spot-checks: type/amount/date exact (e.g. Khanna brokerage pages);
  known weak spot is owner attribution on dense multi-trust schedules —
  uncertainty carried in per-row `note` fields (2,087 rows) and 7 illegible
  dates set null.
- Inserted as `source='manual'`, `confidence=0.85` via guarded SQL:
  row-level identity guard (a first pass with a doc-level guard
  under-inserted 293/7,010 because ~255 rows from the 2026-07-27 manual
  import pre-existed), occurrence-indexed `row_key`s so legitimate
  trust-split repeats (same asset/date/type/amount, distinct accounts) are
  preserved, per-doc pending-queue cleanup. Idempotent on rerun.
- Cost: $0 API (local subscription compute) vs ~$10–25 of OpenRouter vision
  calls, and it works while the OpenRouter weekly budget is exhausted.

## Data changes (prod)

- 247 filings → `ingest_status='persisted'`, `extractor='local-vision-swarm-1'`.
- ~15,200 live `source='manual'` transaction rows across those docs (plus
  the 28 from the earlier text_pdf parser batch).
- 10 verified "Nothing to report" filings persisted with zero rows.
- Pending `filing.*` queue messages for the 247 docs deleted (LLM re-
  extraction would no-op anyway via `exactLiveSet`).

## Verification

- `SELECT COUNT(*) FROM filings WHERE doc_kind='scanned_pdf' AND ingest_status IN ('error','classified')` → **0**.
- `SELECT COUNT(*) FROM transactions WHERE source='manual' AND deprecated_at IS NULL` → 24,026 (was 9,549).
- Mechanical re-validation of all 16,506 source rows: 0 issues besides 7 noted null dates.

## Follow-ups

- The permanent automation of this path landed as PR #1267
  (`antigravity/ingestion-pipeline-improvements`: local vision worker,
  `localVisionWaitState` brief-wait fallback, deterministic textPdf parsing)
  — verify its deploy and wire the Mac worker (see
  `docs/analysis/2026-08-02-ingestion-pipeline-improvements.md`).
- ~10 docs have fuzzy-name overlaps with the 2026-07-27 abbreviated-name
  manual import (a few dozen possible duplicate trades); enumerate and
  reconcile if analytics flags them.
- 3 executive (OGE 278-T) scanned filings were out of scope (different form).
