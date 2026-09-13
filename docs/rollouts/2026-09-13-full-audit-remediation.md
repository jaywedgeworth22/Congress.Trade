# Rollout Note: 2026-09-13 Full Audit Remediation

## Summary
Full remediation and production deployment for all 5 issues filed during the comprehensive September 2026 codebase and operations audit:
1. **Issue #2364 (PR #2374):** House PTR live search pagination and `FilingType=P` filter, consensus voting placeholder exclusion (`effectiveTotal`), unblocking phantom collisions on `failed` and `not_found` status, and relaxing OGE 278-T OCR regex.
2. **Issue #2365 (PR #2371):** Standardizing on `getCurrentUserFromRequest` across `/billing/*` endpoints to support iOS Bearer tokens, and passing `live.customer` object to resolve disconnected Stripe accounts in the admin premium roster.
3. **Issue #2366 (PR #2372):** Added SQLite WAL mode and foreign keys pragmas in Deno init (`main.ts`), wired R2 weekly backup failure receipt writing in `fleet-sqlite-backup.sh`, configured `CT_COST_PROFILE=paid` in `docker-compose.yml`, and resolved duplicate price snapshot ticks.
4. **Issue #2367 (PR #2376):** Implemented `window.history.pushState` and global `popstate` listener for browser history navigation, wired server-side column sorting to `/api/transactions`, preserved checkout intent across OAuth sign-in, harmonized responsive breakpoints at 768px, and fixed directory table header accessibility.
5. **Issue #2368 (PR #2370):** Added Universal Links Associated Domains entitlement (`applinks:congress.trade`) in XcodeGen `project.yml`, aligned Manage Subscription with StoreKit Guideline 3.1.1, updated push alerts copy, displayed committee regulatory conflict tags in politician profile, refined iPad sheet sizing, and added CI drift detection for `CongressTrade.xcodeproj`.

## Files Changed
- `app/src/deno/main.ts` (WAL mode & foreign key pragmas)
- `app/src/ingestion/houseSource.ts` (`FilingType=P`, DataTables pagination offset)
- `app/src/extraction/consensus.ts` (consensus voting placeholder exclusion & `effectiveTotal`)
- `app/src/ingestion/watcher.ts` (unblock failed/not_found collisions)
- `app/src/extraction/ogeText.ts` (relaxed OCR punctuation regex)
- `app/src/billing/routes.ts` (Bearer auth on `/billing/*`)
- `app/src/admin/premiumRoster.ts` (`customerEmail(live.customer)`)
- `app/src/ui/dashboardHtml.ts` (pushState/popstate, OAuth checkout intent, 768px breakpoint, sort params)
- `clients/ios/project.yml` (Associated Domains entitlement)
- `clients/ios/CongressTrade/Store/ManageSubscription.swift` (Guideline 3.1.1 App Store management URL)
- `clients/ios/CongressTrade/Views/Components/Components.swift` (Push alerts copy)
- `clients/ios/CongressTrade/Views/Feed/PoliticianDetailView.swift` (Conflict tags)
- `scripts/ops/fleet-sqlite-backup.sh` (R2 failure receipt logging)
- `app/docker-compose.yml` (`CT_COST_PROFILE=paid`)

## Verification
- **Test Suite:** All 305 test files passing (3,903 tests) locally and in GitHub Actions CI.
- **Production Deployment:** Live revision at `https://congress.trade/api/health` confirmed running HEAD SHA `011b8ed1` with:
  - `ok: true`, `db: true`, `schema: true`
  - `costProfile: "paid"`
  - `litestreamStatus: "replicating"` (~5s sync latency)
  - All 13 pipeline health checks reporting `ok`
- **GitHub Issues:** #2364, #2365, #2366, #2367, #2368 closed.

## Follow-ups
- Weekly R2 backup snapshot will refresh receipt on the next scheduled Sunday backup run.
