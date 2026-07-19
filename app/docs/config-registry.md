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
`XAI_API_KEY`, `OPENROUTER_API_KEY`, `LLAMAPARSE_API_KEY`,
`ARBITRATION_API_KEY`

`OPENROUTER_API_KEY` is the unified transport for ALL live LLM extraction
(agreement trio + benchmark candidates); its configured/health status is
surfaced in `GET /api/admin/diagnostics` (`provider:openrouter`) and
`GET /api/admin/config-sources`.

### Auth, billing, email
`ADMIN_TOKEN`¹, `INGEST_TOKEN`, `ADMIN_MAINTENANCE_TOKEN`², `ADMIN_EMAILS`, `ACCESS_AUD`,
`ACCESS_TEAM_DOMAIN`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`WEBHOOK_SIGNING_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`, `STRIPE_TRIAL_DAYS`,
`STRIPE_MANAGED_PAYMENTS`, `RESEND_API_KEY`, `EMAIL_FROM`, `ALERT_EMAIL`

² Scoped like `INGEST_TOKEN`: authorizes ONLY the idempotent maintenance
endpoints (`POST /api/admin/ingest-requeue-failed`,
`POST /api/admin/ingest-retry-errored`) — never migrations, review
resolution, or config writes. Safe to hand to agent/automation sessions so
they can drain backlogs without holding `ADMIN_TOKEN`. Worst case if leaked:
someone re-runs an idempotent requeue.

¹ Admin AUTH accepts the Infisical value (rotation works live). Keep a strong
`INFISICAL_APP_CLIENT_SECRET` set as a Worker secret regardless: the encrypted
KV cache of resolved secrets keys off the Infisical client secret (falling
back to the env `ADMIN_TOKEN`), so pulling ADMIN_TOKEN out of Worker env is
safe only while a strong client secret exists.

### Integrations
`APP_B_IMPORT_URL`, `APP_B_INGEST_TOKEN`, `USAGE_MONITOR_ENABLED`,
`USAGE_MONITOR_INGEST_URL`, `USAGE_MONITOR_INGEST_TOKEN`,
`USAGE_MONITOR_ENVIRONMENT`², `USAGE_MONITOR_READ_TOKEN` (optional; read-only
budget-status polling, see Tunables & flags below)

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
- OpenRouter PDF pipeline: `OPENROUTER_MODEL` (default
  `google/gemini-3.5-flash`), `OPENROUTER_PDF_ENGINE_TEXT` (file-parser engine
  for typed/text PDFs; default `cloudflare-ai` — free markdown conversion),
  `OPENROUTER_PDF_ENGINE_SCANNED` (engine for scans read by
  non-native-vision models; default `mistral-ocr`, $2/1k pages),
  `OPENROUTER_MAX_PRICE` (optional per-request provider price ceiling, JSON
  like `{"prompt":5,"completion":20}` in USD per million tokens — composes
  with the daily USD budget governors, it does not replace them)
- Agreement autopublish controls and per-chamber lineups:
  `AGREEMENT_AUTOPUBLISH_ENABLED`,
  `AGREEMENT_HOUSE_MODEL_A/B/C`, `AGREEMENT_SENATE_MODEL_A/B/C`, and
  `AGREEMENT_EXEC_MODEL_A/B/C`,
  `AGREEMENT_AUTOPUBLISH_LIMIT`, `AGREEMENT_MAX_ATTEMPTS`,
  `AGREEMENT_DAILY_LLM_BUDGET`, `AGREEMENT_BIG_DOC_START_TIER2`,
  `AGREEMENT_BIG_DOC_PAGE_THRESHOLD`, `AGREEMENT_BIG_DOC_BYTES_THRESHOLD`
- Provider-health routing + runtime overlay (`src/extraction/providerHealth.ts`;
  billing/auth failures open a per-`provider:model` circuit breaker and the
  live extractor substitutes the cheapest healthy catalog candidate at
  runtime — the configured lineup stays authoritative and resumes on
  recovery):
  - `PROVIDER_HEALTH_WINDOW_MINUTES` — rolling health window (default `15`)
  - `PROVIDER_HEALTH_CONSECUTIVE_THRESHOLD` — consecutive billing/auth
    failures that open the per-model breaker (default `5`)
  - `PROVIDER_HEALTH_FAILURE_RATE` — windowed billing/auth failure-rate trip
    (default `0.8`, needs `PROVIDER_HEALTH_MIN_SAMPLES`, default `5`)
  - `PROVIDER_OVERLAY_ENABLED` — runtime substitution for a breaker-blocked
    slot (default on; `false` restores skip-to-failover-only behavior)
  - `PROVIDER_OVERLAY_COST_RATIO_LIMIT` — substitutes costing more than this
    multiple of the configured slot's rate-card cost are flagged in the
    `ingestion_decisions` audit + diagnostics, never selected silently
    (default `3`)
  - `PROVIDER_MODEL_BAN_TTL_SECONDS` — per-model breaker TTL (default `3600`)
- Backlog autopilot (`src/extraction/autopilot.ts`; cron-gated, queue-driven
  drain of the unresolved review backlog through the SAME agreement cascade —
  status/receipts at `GET /api/admin/autopilot/status`, halted runs need
  `POST /api/admin/autopilot/acknowledge` before a new run may start):
  - `AUTOPILOT_ENABLED` — master switch; effective only where
    `AGREEMENT_AUTOPUBLISH_ENABLED=true`, and `false` disables the autopilot
    without touching the per-minute cascade (default on)
  - `AUTOPILOT_BACKLOG_THRESHOLD` — unresolved-review count that triggers an
    extra same-day run (default `150`; a run always triggers on the first
    cron tick of each UTC day)
  - `AUTOPILOT_DAILY_USD_BUDGET` — per-UTC-day USD spend meter priced via the
    shared benchmark rate card; reservations happen BEFORE model calls and
    the run halts when exhausted (default `5.00`)
  - `AUTOPILOT_MAX_DOCS_PER_RUN` — pilot-sized run cap (default `50`)
  - `AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD` — same-class error count
    (billing/auth/quota/parse/timeout) that halts the whole run with a
    receipt requiring acknowledgment (default `2`)
  - `AUTOPILOT_MIN_INTERVAL_MINUTES` — spacing between backlog-triggered runs
    (default `60`)
  - `AUTOPILOT_BATCH_PRESEED` — pre-seed cascade reads through the cheaper
    direct-provider batch APIs where the chamber trio supports it (default
    off; a no-op for all-OpenRouter trios)
- Monitor-informed budget throttle (`src/shared/monitorBudgetGate.ts`; a
  read-side self-throttle feedback loop — polls the API Usage Monitor's
  cross-app `GET /api/budget-status` so the backlog autopilot backs off a
  provider the monitor already reports at/over budget. Advisory ONLY: it
  composes under the autopilot's own `AUTOPILOT_DAILY_USD_BUDGET` above and
  never touches the essential real-time per-filing ingestion path. FAILS OPEN
  on any error/timeout/misconfiguration — never throttles when it can't get a
  clean answer):
  - `USAGE_MONITOR_READ_TOKEN` — dedicated read token for `GET
    /api/budget-status`; falls back to `USAGE_MONITOR_INGEST_TOKEN` when unset
    (mirrors the monitor's own `USAGE_READ_TOKEN`\|\|`USAGE_INGEST_TOKEN`
    convention)
  - `USAGE_MONITOR_BUDGET_THROTTLE_ENABLED` — master on/off switch (default
    on whenever `USAGE_MONITOR_INGEST_URL`/token are configured)
  - `USAGE_MONITOR_BUDGET_THROTTLE_THRESHOLD` — fraction of monthly budget
    (0-1) at/above which a provider counts as throttled (default `1.0`, i.e.
    the monitor's own `exceeded` status; lower to back off earlier, e.g.
    `0.9`)
  - `USAGE_MONITOR_BUDGET_STATUS_CACHE_TTL_MS` — in-isolate cache TTL for the
    polled response (default `120000` = 2min)
  - `USAGE_MONITOR_BUDGET_STATUS_TIMEOUT_MS` — bounded request deadline for
    the poll itself (default `5000`, hard cap `15000`)
- Document classifier (`src/extraction/docClassifier.ts`; assigns
  `filings.doc_class` ∈ typed | clean_scan | hard_scan | empty | corrupt —
  deterministic signals first, ONE ~free enum-constrained OpenRouter call
  only for ambiguous scans. Consumers: autopilot ordering (typed/clean
  first), cascade start tier (hard_scan → full trio), empty auto-resolve +
  corrupt quarantine, receipt attribution):
  - `DOC_CLASSIFIER_ENABLED` — model tier for ambiguous docs (default on;
    `false` = deterministic signals only, ambiguity defaults to hard_scan)
  - `DOC_CLASSIFIER_MODEL` — bottom-tier OpenRouter model for the one
    classification call (default `google/gemini-2.5-flash-lite`)
  - `DOC_CLASSIFIER_PARSE_ENGINE` — OpenRouter file-parser engine for the
    classification call (default `cloudflare-ai`, the free parse)
  - `DOC_CLASS_EMPTY_SPOTCHECK_RATE` — fraction of doc_class=empty docs left
    in review for a human spot-check instead of auto-resolving (default
    `0.1`)
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

For local development, `scripts/cloud-setup.sh` maps the canonical
`INFISICAL_CT_CLIENT_ID` / `INFISICAL_CT_CLIENT_SECRET` inputs to the runtime
`INFISICAL_APP_*` names. It accepts both `INFISICAL_CT_SHARED_*` and the existing
`INFISICAL_SHARED_*` shared-identity names. Existing complete, non-empty
`.dev.vars` pairs have preservation priority. For a missing or empty managed
target, explicit runtime-name environment pairs precede canonical CT environment
aliases and then the corresponding machine-file aliases. Existing non-empty
managed values are never rotated implicitly; deliberately remove or empty a
managed line before re-running setup. An incomplete client-id/client-secret pair
aborts before install. Known nonsecret project IDs are supplied only when the
corresponding complete identity exists. The optional machine-level file must be
a regular owner-only file with no group/other permission bits; exact mode `0600`
is recommended but not required. It is parsed without shell evaluation;
provider keys are never copied from it or the process environment. The only
non-Infisical values imported explicitly for local setup are `SENTRY_DSN`,
`SENTRY_ENVIRONMENT`,
`SENTRY_TRACES_SAMPLE_RATE`, `ADMIN_OPEN_IN_DEV`, and
`USAGE_MONITOR_ENVIRONMENT`. Existing `.dev.vars` parsing is limited to managed
keys using the dotenv 16.3.1 grammar bundled by Wrangler, so colon assignments,
comments, quotes, backslashes, backticks, and multiline values cannot expose a
managed-looking line nested in unrelated content. Unrelated records remain
byte-for-byte unchanged. Imported managed values are emitted only when that
same parser proves an exact single-line round trip; otherwise setup fails
closed. Missing files are allowed; symlinks, including broken symlinks, are
rejected.

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
