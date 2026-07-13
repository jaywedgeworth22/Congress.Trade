# Config Registry — Infisical as the Single Source of Truth

Last updated: 2026-07-11

Every configuration key and knob the Worker reads is routed through the
Infisical runtime resolver (`src/secrets/infisical.ts`) unless listed under
**Env-only** below. Resolution order per key:

1. **Infisical** — the value set in the Infisical project (env `prod` by
   default). Edits go live within the resolver cache TTL
   (`INFISICAL_CACHE_TTL_SECONDS`, default 600s) with **no redeploy**.
2. **Env fallback** — the `wrangler.toml [vars]` value or Worker secret.
   Kept so keyless local dev / tests still boot and so an Infisical outage
   never leaves production unconfigured. Disable with
   `INFISICAL_ALLOW_ENV_FALLBACK="false"` to hard-require Infisical.

**Operate by editing Infisical, not wrangler.toml.** Audit which source is
live for every key at any time: `GET /api/admin/config-sources` (admin-gated;
reports names + sources only, never values).

## Infisical-tunable (everything here is live-editable)

### Provider API keys
`FMP_API_KEY`, `TIINGO_API_KEY`, `MASSIVE_API_KEY`, `INTRINIO_API_KEY`,
`TWELVEDATA_API_KEY`, `FINNHUB_API_KEY`, `UNUSUAL_WHALES_API_KEY`,
`QUIVER_API_KEY`, `QUIVER_API_TOKEN`, `AINVEST_API_KEY`,
`LOGODEV_PUBLISHABLE_KEY`

### Model/LLM keys
`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`,
`XAI_API_KEY`, `LLAMAPARSE_API_KEY`,
`ARBITRATION_API_KEY`

### Auth, billing, email
`ADMIN_TOKEN`¹, `INGEST_TOKEN`, `ADMIN_EMAILS`, `ACCESS_AUD`,
`ACCESS_TEAM_DOMAIN`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`WEBHOOK_SIGNING_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`, `STRIPE_TRIAL_DAYS`,
`STRIPE_MANAGED_PAYMENTS`, `RESEND_API_KEY`, `EMAIL_FROM`, `ALERT_EMAIL`

¹ Admin AUTH accepts the Infisical value (rotation works live). Keep a strong
`INFISICAL_APP_CLIENT_SECRET` set as a Worker secret regardless: the encrypted
KV cache of resolved secrets keys off the Infisical client secret (falling
back to the env `ADMIN_TOKEN`), so pulling ADMIN_TOKEN out of Worker env is
safe only while a strong client secret exists.

### Integrations
`APP_B_IMPORT_URL`, `APP_B_INGEST_TOKEN`, `USAGE_MONITOR_ENABLED`,
`USAGE_MONITOR_INGEST_URL`, `USAGE_MONITOR_INGEST_TOKEN`,
`USAGE_MONITOR_ENVIRONMENT`²

### Tunables & flags
- Budgets/pacers: `FMP_DAILY_CALL_CAP`, `FMP_MAX_PER_MINUTE`,
  `EDGAR_MAX_PER_MINUTE`
- Providers/routing: `PRICE_PROVIDER`, `APP_BASE_URL`
- Anti-scrape: `SCRAPE_GUARD_ENABLED`
- Disclosure-latency race: `DISCLOSURE_LATENCY_WATCH_ENABLED`,
  `DISCLOSURE_LATENCY_PROVIDERS`, `DISCLOSURE_LATENCY_WATCH_LIMIT`,
  legacy `FMP_DISCLOSURE_WATCH_ENABLED` / `FMP_DISCLOSURE_WATCH_LIMIT`
- Ingestion: `HOUSE_LIVE_SEARCH_ENABLED`, `SEED_HOUSE_URL`, `SEED_SENATE_URL`
- Executive (OGE 278-T) watcher: `OGE_WATCH_ENABLED`, `OGE_INDEX_URL`,
  `OGE_POLL_INTERVAL_SEC`, `OGE_MAX_VISION_BYTES`
- Extraction: `VISION_PRIMARY_MODEL`, `ARBITRATION_ENABLED`,
  `ARBITRATION_MODEL`
- Agreement autopublish (all ten): `AGREEMENT_AUTOPUBLISH_ENABLED`,
  `AGREEMENT_AUTOPUBLISH_MODEL_A/_B`, `AGREEMENT_MODEL_C`,
  `AGREEMENT_AUTOPUBLISH_LIMIT`, `AGREEMENT_MAX_ATTEMPTS`,
  `AGREEMENT_DAILY_LLM_BUDGET`, `AGREEMENT_BIG_DOC_START_TIER2`,
  `AGREEMENT_BIG_DOC_PAGE_THRESHOLD`, `AGREEMENT_BIG_DOC_BYTES_THRESHOLD`
- Import guardrails (all seven): `IMPORT_MAX_BYTES`, `IMPORT_MAX_REFS`,
  `IMPORT_MAX_SPX`, `IMPORT_MAX_PRICES`, `IMPORT_MAX_CLOSES_PER_TICKER`,
  `IMPORT_MAX_INSIDER`, `IMPORT_MAX_SHORT_VOLUME`
- Local-dev escape hatch: `ADMIN_OPEN_IN_DEV` (still requires a
  non-production environment to take effect)

² `USAGE_MONITOR_ENVIRONMENT` is Infisical-tunable on its async read paths
(admin-open check, usage telemetry); the sync local-webhook-target gate in
`delivery/webhookTarget.ts` still reads env directly (local-dev-only code
path, never active in production).

## Env-only (cannot move to Infisical)

| Key | Why |
|---|---|
| `INFISICAL_BASE_URL`, `INFISICAL_ENV`, `INFISICAL_CACHE_TTL_SECONDS`, `INFISICAL_ALLOW_ENV_FALLBACK`, `INFISICAL_APP_*`, `INFISICAL_SHARED_*` | Resolver bootstrap — cannot resolve themselves |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | Read synchronously in the `Sentry.withSentry` init factory before any `await` is possible |

## Not env at all (already hot-configurable elsewhere)

- **Poll cadence / Aggressive Mode** — stored in D1 `poll_config` + KV, edited
  live from the Admin · Cadence tab.
- **Site logo style** — admin UI setting (KV).
- **Bindings** (D1/KV/R2/queues) — infrastructure in `wrangler.toml`, not
  configuration values.

## Conventions

- New config keys MUST be read via `resolveSecret`/`resolveSecrets` (env
  fallback comes free) and added to the `GET /api/admin/config-sources`
  registry + this file. Only add an env-only key when the read is genuinely
  sync-at-init or resolver-circular.
- Values must never be logged or echoed by diagnostics — sources and
  configured-booleans only.
