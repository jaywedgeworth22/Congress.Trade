# 2026-08-01 — Fetch 403/404 transient-retry + dual-stage /ingest-retry-errored

## Summary

House/Senate ingestion had been losing filings terminally at the fetch stage:
the Clerk/eFD WAF answers request bursts with short-lived **403s**, and the
House bulk FD index is published **before** the matching PDF, so fresh filings
404 for their first hours. Both were treated as terminal errors (707 filings
errored 2026-07-29 → 2026-08-01). Additionally `POST /api/admin/ingest-retry-errored`
only recovered rows that already had raw bytes in R2; fetch-stage failures
(`raw_object_key IS NULL`) could never be retried.

Changes (PR #1223, merged as `950de68b`):

- `app/src/ingestion/fetcher.ts` — new `shouldRetryFetchStatus()`: 403 is
  transient (standard queue backoff; a genuinely permanent block still
  terminates via the retry budget); 404 is transient while the filing is
  younger than `FETCH_NOT_PUBLISHED_WINDOW_MS` (7 days from `first_seen_at`),
  and stays terminal for old filings.
- `app/src/admin/routes.ts` — `/ingest-retry-errored` is now dual-stage:
  rows with `raw_object_key` resume at `filing.fetched`; rows without it
  re-enqueue `filing.new` (requires chamber + sourceUrl). Response gains a
  `skipped` count for rows with no source URL.

## Files changed

- `app/src/ingestion/fetcher.ts`
- `app/src/admin/routes.ts`
- `app/src/ingestion/__tests__/fetcherRetry.test.ts`
- `app/src/admin/__tests__/ingestRetryErrored.test.ts`

## Verification

- `npm run typecheck` green; full suite 182 files / 1,999 tests green; gitleaks green.
- Deployed via Coolify manual trigger `xzff1o1m8q2rzwrlj2188l21` (auto-deploy
  webhook missed the merge again). Live behavior confirmed by the new
  `skipped` field in the retry route response.
- Post-deploy: `POST /api/admin/migrate` applied; then
  `POST /api/admin/ingest-retry-errored {"limit":2000}` →
  `{matched: 1150, enqueued: 1150, skipped: 0, errors: []}`.
- Prod DB read-only check: new transactions landing again
  (`MAX(transactions.created_at)` advancing past the 2026-07-28 stall).

## Follow-ups

- LLM extraction lanes remain gated on the OpenRouter weekly budget
  (owner billing action; queue retries automatically once budget exists).
- Coolify GitHub→deploy webhook is flaky (missed this merge and #1220/#1221
  earlier); fleet should repair it.
- Monitor that the re-enqueued 1,150 filings drain without re-erroring
  (fetch 403/404s should now retry instead of terminating).
