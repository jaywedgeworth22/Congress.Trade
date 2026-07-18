# D1 Budget Atomic Metering

## Summary

PR #559 replaces the isolate-local/KV read-modify-write daily D1 row counter
with an atomic D1 UPSERT. Aggregate one-row queries now use the metered
`first()` helper, while point reads retain the unmetered `get()` path. The
counter update itself is charged as one D1 write so read-only traffic cannot
silently consume the write budget through accounting flushes.

## Files changed

- `app/migrations/0045_d1_budget.sql` — creates the daily atomic counter table.
- `app/src/admin/migrations.ts` — mirrors migration 0045 for production
  `POST /api/admin/migrate`.
- `app/src/shared/d1Budget.ts` — atomic counter, enforcement reads, and
  fail-open compatibility fallback.
- `app/src/shared/db.ts` and aggregate call sites — metered `first()` helper.
- `app/src/shared/readiness.ts` — schema probe for `d1_budget`.

## Verification

- `npm run typecheck` passed on the PR branch.
- Affected route, migration, database, and budget suites passed: 152 tests.
- PR required checks passed on the Coolify self-hosted runner after recovery:
  `typecheck + test`, `PWA typecheck + test + build`, and `gitleaks`.

## Follow-ups

- Deploy the merged migration through `bash app/scripts/ship.sh` and verify
  `/api/health` reports `schema: true` on the exact production SHA.
- Reconcile the approximate application counter against Cloudflare D1 Row
  Metrics; the latter remains authoritative for billing.
