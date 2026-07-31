# 2026-07-31 — Price performance restored: flat-file backfill + SocraticTrade-primary price chain

## Summary

Price performance (`tx_performance` anchors) had silently stalled: 4,148 of 4,152
traded tickers needed prices and ~20k trades were missing price/SPX anchors. Three
stacked causes, all fixed:

1. **FMP account suspended** — every FMP call returned HTTP 403, and
   `runPriceRefresh` treats 403 as run-fatal, so each daily run priced zero tickers.
2. **socratic.trade DNS broken** — the zone's A/AAAA records pointed at Cloudflare
   anycast IPs ("DNS points to prohibited IP", edge 403), killing both the peer
   price pull and the outbound share push. The domain is a redirect alias of
   **socratictrade.com**.
3. **Shared Massive key rate-limited (429)** — after switching to Massive, runs
   aborted on the first 429 (also classified run-fatal).

Fixes shipped:

- **Bulk backfill from the already-downloaded Massive flat files**
  (`Socratic.Trade/data/history-5y/*.json`, 5y daily bars): a one-off script pushed
  1,672 tickers / 2,015,160 closes (94 batches, zero errors) through the idempotent
  `POST /api/admin/securities/import`, which also recomputed `tx_performance`
  anchors. `tradesMissingPriceAnchor` dropped 20,066 → 10,961.
- **SocraticTrade is now the primary price source.** New token-gated read routes on
  SocraticTrade (`GET /api/market/prices/{symbol}`, `GET /api/market/spx`,
  Socratic.Trade PR #2314) serve descending closes; congress.trade's peer client now
  sends the shared `st_ingest_…` bearer (PR #1195). Chain: SocraticTrade → Massive
  (unmetered fallback). `PRICE_PROVIDER=massive` confirmed in Infisical prod.
- **429 resilience** (PR #1196): Massive/Tiingo clients retry 429 with bounded
  backoff; 429 no longer aborts the run for unmetered providers (401/402/403 still
  abort; FMP 429 still aborts).
- **socratic.trade → socratictrade.com 301 redirect** restored at Cloudflare
  (placeholder proxied records + zone redirect rule, path/query preserved);
  `APP_B_IMPORT_URL` updated to `https://socratictrade.com/api/admin/securities/import`
  in `app/.prod.vars` and both Infisical prod projects (the shared project still had
  the older `trading.jays.services` value).
- **Ops:** the SocraticTrade deploy had failed on a full build-host disk
  (`no space left on device`); pruned ~25GB of unused Docker images/build cache on
  the Coolify host and redeployed. congress-trade does **not** auto-deploy on push
  (despite the `npm run deploy` echo) — deployed manually via the Coolify API.

## Files changed

- `app/src/prices/peer.ts`, `app/src/prices/service.ts` (PR #1195 — bearer auth + secret resolution)
- `app/src/prices/retry429.ts`, `massive.ts`, `tiingo.ts`, `service.ts` (PR #1196)
- Socratic.Trade: `app/api/market/prices/[symbol]/route.ts`, `app/api/market/spx/route.ts`,
  `src/lib/market-read.ts`, `middleware.ts` (PR #2314)
- `app/.prod.vars` (`APP_B_IMPORT_URL`); Cloudflare `socratic.trade` zone DNS + redirect rule

## Verification

- `curl -H "Authorization: Bearer $APP_B_INGEST_TOKEN" https://socratictrade.com/api/market/spx` → 200, descending closes.
- Bounded `POST /api/admin/backfill-market {"max":15}` on prod: `spxUpdated: true`,
  12 tickers priced, 20 trades computed, `aborted: false`, zero errors.
- `GET /api/export/price-needs` summary: SPX `latestCached` current (2026-07-30);
  `tradesMissingPriceAnchor` 10,961 (was 20,066).

## Follow-ups

- Remaining ~2,059 pending tickers are mostly no-flat-file names (mutual funds,
  foreign, unparsable junk tickers); the daily 00:00 UTC refresh (budget 5,000,
  unmetered) will top up the recent tail on the 1,672 backfilled tickers and
  negative-cache the unpriceable set. Re-check `price-needs` summary after the run.
- Enrichment still uses the suspended FMP key and burns ~283 calls/day on 403s —
  needs its own provider decision (out of scope here).
- FMP suspension unresolved with the vendor; `FMP_API_KEY` remains in config but is
  dead weight until reinstated.
- `CLOUDFLARE_ST_API_TOKEN`/`CLOUDFLARE_ST_API_KEY` could not authenticate for DNS —
  the redirect was fixed with `CLOUDFLARE_JAY_API_KEY`. The ST token needs DNS Edit +
  Redirect Rules grants if it is meant to be the credential for that zone.
