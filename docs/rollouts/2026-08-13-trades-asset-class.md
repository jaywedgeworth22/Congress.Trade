# 2026-08-13 — Trades asset-class dropdown + CSV toolbar parity

## Summary

Leftover from the filter-bar takeover audit.  The owner-requested Trades dropdown (**All** / **Public Equities, Funds, & ETFs**) existed only as `?assetClass=` on the server.  CSV export also ignored party and rolling time windows.

## Files

- `app/src/ui/dashboardHtml.ts` — `#qAssetClass` on Trades extras; `tradesFilterParams` sends `assetClass`; `exportCsv()` uses `tradesFilterParams()`
- iOS `AssetClassFilter`, Trades-only pill, `FeedQuery.assetClass`, CSV export gets party + assetClass

## Verification

- vitest `dashboardHtml` 263
- iOS `testSetAssetClassSendsAssetClassQueryParam`
