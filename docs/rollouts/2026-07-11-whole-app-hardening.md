# Whole-App Hardening Program

## Summary

The 2026-07-11 audit findings are implemented on
`codex/app-hardening-integration`, 11 implementation commits plus this closeout
record over `origin/main`. The work
closes silent-loss and false-green paths across queue ingestion/delivery,
readiness and migrations, Stripe state, public webhook safety, the Next.js PWA,
and the SwiftUI client.

The isolated preview is healthy at
`https://congress-trade-preview.jaywedgeworth22.workers.dev`, Worker version
`85417928-cae4-4bb6-8706-96c739846533`. The first post-deploy readiness check
returned 503 because the long-lived preview D1 had recorded migration `0008`
without its unique transaction row-key index. Readiness identified the exact
missing invariant. The preview contained no duplicate row keys, so the index was
recreated on the preview database and readiness then returned
`ok=true`, `db=true`, `schema=true`.

Nothing was pushed, merged, or deployed to production. No production migration,
ingestion, queue operation, or billing activation ran.

## Files changed

- `app/src/ingestion/`, `app/src/delivery/`, `app/src/extraction/normalizer.ts`,
  and `app/src/index.ts`: transactional outboxes, active DLQ recovery,
  completion-before-ACK, stale-enqueued replay, bounded fetches, atomic
  publication, cross-isolate SSE leases/backpressure, quotas, and public-webhook
  SSRF enforcement.
- `app/src/shared/readiness.ts`, `app/src/admin/`, `app/migrations/0029_*` through
  `0032_*`, `app/scripts/deploy-preview.sh`, `provision-preview.sh`, and `ship.sh`:
  schema-aware readiness, real SQLite parity coverage, materialized estimates,
  truthful source attempts, Stripe event ordering, preview config refresh, and
  liveness-before-migration/readiness-after-migration deployment sequencing.
- `app/src/billing/`, `app/src/auth/`, `app/src/security/`, `app/src/ui/`, and
  `app/wrangler*.toml`: reclaimable/idempotent Stripe processing, monotonic
  subscription state, checkout/portal capability separation, dual-mode logout,
  browser security headers, queue consumers, and safer outbound-fetch policy.
- `clients/pwa/` and `.github/workflows/ci.yml`: server-backed filters, guarded
  account writes, one-time credential handling, stable intent keys, accessible
  filter dialog, readable failure states, installable/offline assets, focused
  tests, production build/audit gates, and same-origin documentation.
- `clients/ios/`: retained one-time credentials, active-only patches, server
  preference hydration, stable retry intents, bearer revocation, bounded cache
  and offline state, accessibility/formatter/search improvements, an XCTest
  target, and opaque release icon assets.

## Verification

- App: `npm run typecheck` passed; `npm test` passed 95 files / 808 tests;
  coverage passed at 67.90% statements, 60.14% branches, 71.91% functions, and
  70.15% lines; lint passed with 0 errors and 76 existing warnings; npm audit
  reported 0 vulnerabilities.
- Database: a fresh isolated D1 applied all 28 migration files. Real
  `node:sqlite` tests compare file migrations with the admin migration tail,
  execute readiness probes, and verify idempotent transaction insertion, cursor
  assignment, estimate materialization, duplicate suppression, and one outbox
  row.
- Deploy artifacts: production and preview Wrangler dry-runs passed; all deploy
  scripts passed shell syntax checks. Only the isolated preview was deployed.
- PWA: typecheck passed; 3 files / 13 tests passed; optimized Next.js production
  build passed; npm audit reported 0 vulnerabilities; manifest, service worker,
  and 192/512/Apple icon checks passed.
- iOS: generic iOS Simulator build and build-for-testing passed; the compiled
  1024x1024 app icon is opaque. XCTest execution could not run because
  `simctl` reports no installed concrete Simulator device/runtime.
- Rendered QA: desktop 1280x720 and phone 390x844 layouts have no horizontal
  overflow. Dashboard window selection, Trades navigation, and the PWA filter
  dialog worked. Guest/free, billing-unconfigured, and API-unavailable states
  were verified with no browser console warnings or errors.

## Follow-ups

- Run the XCTest bundle and capture device/Instruments measurements when a
  concrete iOS Simulator runtime or physical device is installed.
- Rebase and reconcile active migration-bearing PRs before merge; do not reuse
  another lane's migration number or overwrite its worktree.
- Obtain explicit owner approval before push/PR merge or any production deploy,
  schema migration, ingestion/queue action, or billing activation.
