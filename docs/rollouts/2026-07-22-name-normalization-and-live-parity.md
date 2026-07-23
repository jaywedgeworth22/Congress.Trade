# Name normalization and live parity

## Summary

The live dashboard was inserting spaces between every character in filer names.
The root cause was regex backslashes being consumed by the `dashboardHtml.ts`
template literal; the empty-parentheses cleanup regex therefore became a
zero-width matcher. This rollout also makes name cleanup consistent across new
House/Senate ingestion and the public API, so existing malformed rows render
correctly without changing their stable filer IDs.

## Files changed

- `app/src/ui/dashboardHtml.ts` — preserve regex escapes and remove standalone
  honorific/professional title tokens in the shipped formatter.
- `app/src/extraction/nameNormalizer.ts` — shared filer-name canonicalization.
- `app/src/ingestion/watcher.ts` — canonicalize House/Senate discovery and
  persisted filer names.
- `app/src/analytics/routes.ts`, `app/src/delivery/rows.ts`,
  `app/src/delivery/rest.ts` — canonicalize names at API boundaries for PWA,
  iOS, REST, SSE, and analytics consumers.
- `app/src/shared/types.ts` — declare Deno S3 compatibility environment keys so
  the required typecheck gate passes.

## Verification

- `npm run typecheck`
- `npm test -- --run`
- Targeted dashboard/name/delivery tests cover the exact malformed examples.
- Production was read-only verified before this change: deployed SHA
  `8f696317`, `/api/health` healthy, 13,220 live transactions, and populated
  90-day analytics. No production database write or deploy was performed by
  this branch.

## Follow-ups

- Run an approved, auditable D1 backfill to rewrite stored `filers.full_name`
  values after deployment. Keep existing filer IDs stable; do not merge IDs
  solely because a source title was malformed.
- Recheck R2 raw-object inventory after the account entitlement issue is fixed;
  API/D1 parity alone does not prove raw-file completeness.
