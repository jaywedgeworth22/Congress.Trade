# 2026-08-03 — CT prices from Socratic.Trade (App B) only [GROK]

## Summary

Owner: there will not be a new Massive key; Congress.Trade must get all EOD
prices from Socratic.Trade (App B).

### Code

- `PRICE_PROVIDER=peer` (aliases: `socratic`, `app_b`) → sole App B client with
  **strict** auth (401/403 throw `PEER_HTTP_*`, no silent Massive fallthrough).
- Unset `PRICE_PROVIDER` + configured `APP_B_IMPORT_URL` + `APP_B_INGEST_TOKEN`
  also selects peer-only (so a forgotten `massive` string is the only way to
  re-enable paid providers).
- Legacy `massive` / `fmp` / `tiingo` still work; when App B URL is set they keep
  soft peer-first + paid secondary (migration only).

### Ops

- Infisical CT prod: `PRICE_PROVIDER=peer` (was `massive`).
- `APP_B_INGEST_TOKEN` re-synced to ST’s token (CT copy had drifted → 401).
- Bulk history load: `analysis/massive-bulk-load/load_prices_st.py` against prod
  SQLite via ST market-read routes (resumable, INSERT OR IGNORE).

## Verification

```bash
# peer auth
curl -sS -H "Authorization: Bearer $APP_B_INGEST_TOKEN" \
  'https://socratictrade.com/api/market/prices/AAPL?from=2025-01-01&to=2025-01-10' | jq '.closes|length'

# app unit
cd app && npm run typecheck && npm test -- src/prices
```

## Follow-ups

- Drain `load_prices_st.py` to completion for full securities_master coverage.
- Optional: drop or ignore `MASSIVE_API_KEY` in CT Infisical once peer-only is
  stable for a week.
