# FMP latency ERROR + duplicate Exec Source Health rows

## Summary

Owner 2026-09-04: admin Diagnostics showed Latency · FMP Stable as ERROR
("last observation 42h") while RapidAPI was OFF, and Source Health listed
Exec twice.

Three different FMP cards:

1. **FMP Market Data (enrichment)** — intentionally OFF.  FMP free keys are
   reserved for disclosure-latency probes, not prices.  The 99440 / 8 today
   counts are leftover `securities_ref.enriched_at` rows, not live probes.
2. **Latency · FMP Stable** — this is the real congress probe.  Both free-tier
   keys (`FMP_LATENCY_API_KEY` and `_2`) still return HTTP 200 on
   `house-latest` / `senate-latest`.  The ERROR was 42h without a new
   `trade_provider_observations` row.  Live `/api/health/latency` was
   stalled with the same 42h figure.  After 2026-09-02, latency fetches
   went through `RESIDENTIAL_PROXY_URL` (meant for Clerk/eFD Imperva).
   Commercial JSON APIs now go **direct**.
3. **Latency · FMP RapidAPI** — OFF on purpose.  Rechecked 2026-09-04:
   RapidAPI FMP product still 404s `house-latest` / `senate-latest`
   ("Endpoint does not exist") while `/v3/profile/AAPL` is 200.  Enabling
   it would rotate away from the working dual stable keys and cut useful
   frequency.  Do not set `FMP_LATENCY_PATHS=stable,rapidapi` until the
   marketplace lists those congress endpoints.

Source Health mapped both `executive` and `oge` ingest sources to the
label **Exec**, so a live OGE poller and an empty `executive` alias showed
as two Exec rows (one `unknown (TBD)`, one empty `ok`).  Health SQL now
canonicalizes `oge`/`exec` → `executive`.  Public `/api/health/polling`
already showed a single live executive poller.

Latency diagnostic cards now read `provider_probe_runs` for Last Used /
Total instead of hardcoded zeros.

## Files

- `app/src/ingestion/tradeLatency.ts`
- `app/src/ingestion/__tests__/tradeLatency.test.ts`
- `app/src/admin/routes.ts`
- `app/src/admin/__tests__/sourceHealth.test.ts`

## Verification

- Direct FMP stable house/senate-latest: HTTP 200 on both keys (status only)
- RapidAPI congress paths: HTTP 404; `/v3/profile/AAPL`: HTTP 200
- `cd app && npm run typecheck` (deno check src/deno/main.ts, exit 0)
- `cd app && npx --no-install vitest run src/admin/__tests__/sourceHealth.test.ts src/ingestion/__tests__/tradeLatency.test.ts` (77 passed)
- `cd app && npm test` (301 files / 3834 tests)

## Follow-ups

- Coolify auto-deploys on merge.  After deploy, `/api/health/latency` should
  leave `stalled` once FMP observations resume (direct fetch).
- Re-enable RapidAPI congress only after marketplace 200 on house/senate-latest.

Board: `d09acd0a`.
