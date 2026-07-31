# 2026-07-30 — Price-needs export for congressional trade performance vs S&P

## Summary

Adds `GET /api/export/price-needs` (bearer `INGEST_TOKEN`) so Socratic.Trade can
discover which **congressional** tickers still lack EOD price / SPX history for
`tx_performance` anchors, then deep-share those series into
`POST /api/admin/securities/import`.

## Files changed

- `app/src/export/priceNeeds.ts` — selection + pagination + summary
- `app/src/export/routes.ts` — route + capabilities advertisement
- `app/src/export/__tests__/priceNeeds.test.ts`

## Verification

- `cd app && npm test -- --run src/export/__tests__/priceNeeds.test.ts`
- After deploy: `curl -H "Authorization: Bearer $INGEST_TOKEN" https://congress.trade/api/export/price-needs | jq .summary`

## Follow-ups

- Socratic.Trade: pull this list (`fromAppANeeds`), fullHistory share, enable `CONGRESS_SHARE_ENABLED`.
