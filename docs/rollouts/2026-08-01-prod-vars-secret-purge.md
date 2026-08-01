# 2026-08-01 — .prod.vars secret purge (round 2) (KIMI, owner-directed)

## Context & Objective

`app/.prod.vars` — scrubbed from git history on 2026-07-29 when this repo went
public — was re-committed with ~34 LIVE secrets on 2026-07-30 (PR #1178) while
the repo was still public (window unknown; repo is private again now). Owner
directive 2026-08-01: move secrets out, scrub again, rotate.

## Changes Made (this PR)

- `app/.prod.vars`: all 34 secret values replaced with empty placeholders +
  pointer comments. Non-secret runtime config (feature flags, budgets, model
  names, endpoints) stays in the file. The app merges file -> process env
  (process env wins), so prod is unaffected: secrets are already live in the
  Coolify app env store (encrypted at rest, `Applications -> congress-trade ->
  Environment Variables`), which Coolify writes into the deploy env-file.
- `.gitignore`: `.prod.vars.local` patterns for local dev overrides.

## Pre-merge state (already done on the Oracle prod box, KIMI)

- All 34 secrets + TURSO_DATABASE_URL + INFISICAL_*_PROJECT_ID +
  SQLITE_WEB_PASSWORD present in Coolify's encrypted env store for the
  congress-trade app; verified by model-accessor read-back (plaintext match).
- Congress redeployed from this store (deploy finished, /api/health 200).
- IMPORTANT Coolify trap re-learned the hard way: `EnvironmentVariable` casts
  `value => encrypted`. Write PLAINTEXT via the model (cast encrypts once) or
  pre-encrypted via `DB::table` (bypasses casts). Model-write of a
  pre-encrypted value double-encrypts and the deploy env-file then contains
  payloads — apps crash on garbage config.

## Follow-ups (tracked on the effort board)

- Git history scrub of the 34 secret literals (filter-repo --replace-text),
  then force-push. Coordinated window needed (force-push breaks open lanes).
- Rotation: agent-controlled tokens rotated by KIMI (APP_B_INGEST_TOKEN,
  ADMIN_TOKEN, INGEST_TOKEN, USAGE_MONITOR_INGEST_TOKEN, CLOUDFLARE_CT_API_TOKEN);
  provider dashboards (Stripe live key, Google OAuth, FMP/Finnhub/Tiingo/
  Massive/TwelveData/AlphaVantage/Intrinio/Quiver/UnusualWhales/FRED/OpenRouter/
  Resend/LlamaParse/Logo.dev/Deno/Turso/AWS+R2 keys) need the OWNER.
- Prune old congress app images on the prod box (they contain the baked file).
