# Explicit per-chamber agreement lineups

## Summary

Removed the global agreement model A/B/C settings and all runtime fallbacks.
House, Senate, and Executive agreement cascades now read only their explicit
Infisical A/B/C keys. An incomplete or malformed chamber lineup fails closed
into human review instead of silently selecting another chamber or a default.

## Files changed

- `app/src/extraction/agreement.ts` — explicit lineup resolution and fail-closed
  handling.
- `app/src/benchmark/settings.ts` — chamber-only settings and version hashes.
- `app/src/admin/routes.ts`, `app/src/shared/types.ts` — registry/type cleanup.
- `app/wrangler.toml`, preview/dev examples, and configuration docs — removed
  global model values and documented Infisical ownership.
- Agreement/admin/benchmark tests — chamber-scoped fixtures and missing-config
  coverage.

## Verification

- `npm run typecheck`
- `npm run lint -- --quiet`
- `npm test` — 127 files / 1,281 tests
- Preview Worker: `https://congress-trade-preview.jaywedgeworth22.workers.dev`
  (`/api/health`: `ok=true`, `db=true`, `schema=true`, no missing migrations).
- Production Infisical audit: nine chamber keys present; no global model keys.

## Follow-ups

Benchmark the hard-coded semantic vision primary and Anthropic exception path
separately; do not promote a provider without stratified scanned-PDF ground
truth and measured cost/latency/error receipts.
