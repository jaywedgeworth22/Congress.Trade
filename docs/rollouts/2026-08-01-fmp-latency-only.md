# FMP keys → latency-only (prices via Massive, enrichment via non-FMP chain)

**Date:** 2026-08-01 · **Owner directive:** "don't use FMP at all for prices or enrichment, use it only for latency stuff for both keys. use other sources for enrichment" (FMP plan = 250 calls/day; flat files cover price history).

## Summary

Both FMP keys (`FMP_API_KEY`, `FMP_LATENCY_API_KEY`) are now reserved exclusively for the disclosure-latency race monitor (`src/ingestion/tradeLatency.ts`). FMP no longer spends calls on price refresh or securities enrichment.

- **Prices** — `PRICE_PROVIDER=massive` set BOTH in Infisical prod (07-30) and as a **Coolify runtime env var** on the `congress-trade` app (belt-and-suspenders; Coolify env wins on conflicts; app restarted, health green). Massive/Polygon aggregates are unmetered against the FMP budget. (Runtime Infisical resolution itself was repaired on 07-30 — `INFISICAL_APP_PROJECT_ID` had never been set on Coolify — so either path now works; see the secret-resolution entry in `docs/EFFORT-LOG.md`.)
- **Enrichment** — new code gate `FMP_ENRICHMENT_ENABLED` (default **OFF**) in `app/src/enrichment/service.ts`. `runEnrichment` and `hasConfiguredKeyedEnrichmentProvider` only count `FMP_API_KEY` when the knob is explicitly truthy (`true/1/yes/on`). With the knob unset, the chain runs massive → intrinio → twelvedata → finnhub → tiingo → edgar. This works regardless of where `FMP_API_KEY` is defined (Coolify env, baked vars, Infisical), which is why a code gate was chosen over deleting the secret.

## Files changed

- `app/src/enrichment/service.ts` — `FMP_ENRICHMENT_ENABLED` knob + policy comments; FMP gated out of the enrichment chain and keyed-provider detection by default.
- `app/src/enrichment/__tests__/enrichment.test.ts` — knob semantics tests (key-alone = false, `'false'` = false, `'true'` = true).
- Coolify runtime env (not a repo file): `PRICE_PROVIDER=massive`.

## Unchanged / intentional

- Latency probe keeps both keys (`FMP_LATENCY_API_KEY` preferred, `FMP_API_KEY` fallback) with the shared `FMP_DAILY_CALL_CAP` budget — its ~3 calls per run are the ONLY FMP spend left.
- The Mac scout stays detection-only (no FMP key) since 07-30; it was burning ~5,760 calls/day unbudgeted against the main key before that.
- `backfill/fmpSenateRecovery.ts` still reads `FMP_API_KEY` — manual admin recovery tool only, not a scheduled spend. If FMP must be fully inert there too, repoint it at `FMP_LATENCY_API_KEY` in a follow-up.
- Admin diagnostics copy (`routes.ts` ~3844-3861) still talks about FMP fallbacks; cosmetic, left for a follow-up to keep this diff small.

## Verification

- `npm run typecheck` clean; `npm test` 1,990/1,990 green (incl. new knob tests).
- Coolify: `PRICE_PROVIDER=massive` set (201), app restart `zhaxbcvxu1cq8fw6jv9sz1od` completed, `GET /api/health` ok/db/schema true.
- After merge: Coolify auto-deploy applies the enrichment gate; next enrichment cron pass should log zero `fmpCalls` with chain misses falling to massive/intrinio/edgar.

## Follow-ups

- Watch the next price-refresh lane log to confirm `provider=massive` (no FMP metering).
- If enrichment coverage regresses on fields only FMP filled (e.g. some logo/market-cap shapes), either accept the gap or set `FMP_ENRICHMENT_ENABLED=true` in Coolify env temporarily — the knob makes it a one-line revert.
- Fix runtime Infisical resolution (revoked baked identities) so future config doesn't need Coolify env surgery — tracked from the 07-30/08-01 rollout notes.
