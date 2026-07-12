# Infisical as the single source of truth for config

Branch: `claude/antigravity-latency-security-x6lkvb` (Claude), second commit on
PR #300. Not deployed by this change.

## Summary

Owner request: consolidate as many knobs/keys/settings as possible into
Infisical so there is one place to adjust configuration, and eliminate local
env sprawl.

Audit result first: the codebase was already ~90% there — all provider/model/
Stripe/OAuth keys, admin/ingest tokens, `AGREEMENT_*`, `IMPORT_MAX_*`, and
Access config already resolve through `src/secrets/infisical.ts` (Infisical
value wins; env is fallback), and poll cadence is D1/KV-driven via the admin
UI. This change closes the remaining gaps and makes the posture auditable:

1. **Converted the last direct env reads to the resolver** (Infisical-first,
   env fallback, zero behavior change when Infisical doesn't define the key):
   `FMP_MAX_PER_MINUTE` (latency probe + enrichment + prices),
   `EDGAR_MAX_PER_MINUTE`, `DISCLOSURE_LATENCY_WATCH_LIMIT`,
   `DISCLOSURE_LATENCY_PROVIDERS`, legacy `FMP_DISCLOSURE_WATCH_*`,
   `HOUSE_LIVE_SEARCH_ENABLED`, `SEED_HOUSE_URL`/`SEED_SENATE_URL`,
   `ADMIN_OPEN_IN_DEV` + `USAGE_MONITOR_ENVIRONMENT` (admin-open check),
   `hasFmpKey` + `hasConfiguredKeyedEnrichmentProvider` (admin status),
   and extraction: `ARBITRATION_ENABLED` now resolves at extraction time (the
   secondary vision extractor is always constructed — no I/O — so arbitration
   can be switched on purely from Infisical), and `VISION_PRIMARY_MODEL` /
   `ARBITRATION_MODEL` resolve per-extraction so model swaps are live.
2. **`GET /api/admin/config-sources`** — audit endpoint listing every known
   key with the source its live value comes from (`infisical` / `env` /
   `missing`), plus the env-only and bootstrap registries. Names and sources
   only, never values (pinned by test).
3. **Docs**: new `app/docs/config-registry.md` (full key registry, env-only
   exceptions and why, conventions for new keys); `wrangler.toml [vars]`
   re-documented as fallback defaults; `.dev.vars.example` now recommends the
   minimal setup (Infisical bootstrap creds only — local dev then pulls live
   config exactly like production).

## Hard limits (cannot move to Infisical)

- `INFISICAL_*` bootstrap credentials (resolver can't resolve itself).
- `SENTRY_DSN` / `SENTRY_ENVIRONMENT` / `SENTRY_TRACES_SAMPLE_RATE` — read
  synchronously in the `Sentry.withSentry` init factory.

Env fallbacks are deliberately KEPT (not deleted): Infisical stays the only
place you edit, while an Infisical outage on a cold isolate can't leave
billing/admin/ingestion unconfigured. `INFISICAL_ALLOW_ENV_FALLBACK="false"`
exists for a hard-require posture.

## Files changed

- `app/src/ingestion/fmpDisclosureLatency.ts`, `app/src/ingestion/watcher.ts`
- `app/src/prices/service.ts`, `app/src/enrichment/service.ts`
- `app/src/admin/routes.ts` (+ `GET /config-sources`)
- `app/src/backfill/seed.ts`
- `app/src/extractors/types.ts`, `app/src/extraction/visionLlm.ts`
- `app/src/shared/types.ts` (Env keys), `app/wrangler.toml`,
  `app/.dev.vars.example`
- `app/docs/config-registry.md` (new),
  `app/src/admin/__tests__/configSources.test.ts` (new)

No migrations.

## Verification

- `cd app && npm run typecheck && npm test` — 109 files / 959 tests green.
- Live against `wrangler dev`: `GET /api/admin/config-sources` returns per-key
  sources (`FMP_API_KEY → env` with a local key set; unset keys → `missing`;
  resolver `enabled:false` without bootstrap creds) and leaks no values.
- Post-deploy: hit `GET /api/admin/config-sources` on production — keys
  present in Infisical should report `source: "infisical"`; anything reporting
  `env` still has only a wrangler/Worker-secret value and can be migrated by
  adding it to Infisical (no code change needed — the resolver fetches the
  whole folder).

## Follow-ups

- After confirming production reports `infisical` for all managed keys,
  optionally set `INFISICAL_ALLOW_ENV_FALLBACK="false"` and/or delete
  redundant Worker secrets (keep a strong `INFISICAL_APP_CLIENT_SECRET`; see
  the ADMIN_TOKEN note in config-registry.md).
- The sync local-dev-only reads in `delivery/webhookTarget.ts` remain env
  (never active in production).
