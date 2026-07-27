# Deploy runbook — Congress.Trade

Cloudflare Workers service that ingests US congressional STOCK Act disclosures
(House + Senate), extracts/normalizes trades, and pushes them to clients via
webhook + SSE, with a dashboard and admin panel. This runbook takes a fresh
checkout to a running deployment.

`wrangler.toml` in this repository currently targets the production Worker
service `congress-trade`, the live `congress.trade` custom domains, and real
Cloudflare resource IDs. Treat `npm run deploy`, `npm run deploy:full`,
`scripts/ship.sh`, and remote D1 commands as production operations unless you
have intentionally changed the config or selected another environment.

Note for agents: only the Worker service names were renamed to `congress-trade`
and `congress-trade-preview`. Existing D1/R2/queue resources may still use
legacy `congress-feed-*` names in config and provisioning docs until a deliberate
resource migration happens.

## 0. Prerequisites
- Node 18+ and npm.
- A Cloudflare account; `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
- `cd app && npm install`.
- Verify locally before deploying: `npm run typecheck && npm run test`.

## 1. Provision Cloudflare resources
For the existing production app, the D1 database and KV namespace IDs are already
committed in `wrangler.toml`, and the R2 bucket / queues are named there. Do not
run provisioning against production unless you are intentionally recreating
resources.

For a fresh Cloudflare account or staging environment, run from `app/`. Each
command prints an ID to copy into a separate config or environment-specific
`wrangler.toml`.

```bash
# D1 database  -> copy database_id
npx wrangler d1 create congress-feed-db

# KV namespace -> copy id
npx wrangler kv namespace create CONFIG_KV

# R2 bucket (name already matches wrangler.toml)
npx wrangler r2 bucket create congress-feed-raw

# Queues + dead-letter queues
npx wrangler queues create congress-feed-ingest
npx wrangler queues create congress-feed-delivery
npx wrangler queues create congress-feed-ingest-dlq
npx wrangler queues create congress-feed-delivery-dlq
```

If you use `scripts/provision.sh`, read the script header first. It creates
resources and patches placeholder IDs when present, but production schema still
goes through `scripts/ship.sh` / `POST /api/admin/migrate`.

## 2. Apply the database schema
```bash
# local (for `wrangler dev`)
npx wrangler d1 migrations apply DB --local
# production
ADMIN_TOKEN=... bash scripts/ship.sh
```
This creates all tables and seeds `poll_config` row 1 with the default adaptive
schedule (Mon–Fri 08–19 ET = 300s, evenings = 1200s, weekends = 3600s).

## 3. Secrets and vars
Infisical is the intended source of truth. Cloudflare should store only the
Infisical machine-identity bootstrap credentials:

```bash
npx wrangler secret put INFISICAL_APP_PROJECT_ID
npx wrangler secret put INFISICAL_APP_CLIENT_ID
npx wrangler secret put INFISICAL_APP_CLIENT_SECRET
npx wrangler secret put INFISICAL_SHARED_PROJECT_ID
npx wrangler secret put INFISICAL_SHARED_CLIENT_ID
npx wrangler secret put INFISICAL_SHARED_CLIENT_SECRET
```

The Worker reads provider/app secrets from Infisical at runtime and caches them
briefly in isolate memory. Existing Cloudflare provider secrets may remain during
the migration as compatibility fallback while `INFISICAL_ALLOW_ENV_FALLBACK` is
not set to `"false"`. After production diagnostics show Infisical is reachable
and required keys are resolved, delete and rotate the old Cloudflare provider
secret copies.

Arbitration is **off** until `ARBITRATION_ENABLED = "true"` is present (set it in
`wrangler.toml` `[vars]`, Infisical, or `.dev.vars`). Flipping it on makes the
vision extractor run primary + secondary and reconcile. For local dev, run
`bash scripts/cloud-setup.sh` from the repository root; do not copy the reference
`.dev.vars.example` template.

Admin auth fails closed by default. Set `ADMIN_TOKEN` or configure Cloudflare
Access (`ADMIN_EMAILS`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`). Only local
development should use `ADMIN_OPEN_IN_DEV="true"`.

## 3a. Sentry error monitoring
The Worker is instrumented with `@sentry/cloudflare` (`Sentry.withSentry` in
`src/index.ts`) — errors from `fetch`, the per-minute `scheduled` cron, and both
queue consumers are captured automatically, plus D1 query spans, outbound-fetch
spans, and a Sentry Crons check-in per cron tick. It's fully wired but inert
until a DSN is set:

```bash
npx wrangler secret put SENTRY_DSN
```

Get the DSN from Sentry → Projects → congress-trade → Settings → Client Keys.
`SENTRY_ENVIRONMENT` is already set in `wrangler.toml` / `wrangler.preview.example.toml`
(`production` / `preview`); local dev reads it from `.dev.vars`.

Two optional steps require an interactive Sentry login and can't be scripted by
an agent — run them yourself when you're ready:

- **Readable stack traces (source maps):** `npx @sentry/wizard@latest -i sourcemaps`
  from `app/`, which wires `SENTRY_AUTH_TOKEN` + source map upload into the build.
  Without this, Sentry shows minified stack traces.
- **Native Cloudflare↔Sentry integration** (the one at
  [sentry.io/integrations/cloudflare](https://sentry.io/integrations/cloudflare)):
  in Sentry → Settings → Integrations → Cloudflare, connect the Cloudflare
  account via OAuth. This is separate from the SDK above — it lets Sentry pull
  Workers Logs/analytics and auto-manage source map uploads at the account
  level. Free/cheap on Sentry's Developer plan; skip it if the SDK-level
  coverage above is enough.

## 3b. End-user auth + Stripe paywall (Wave 4)
The public-site account system (Google OAuth + email magic-link) and freemium
paywall (Stripe) have their own copy-paste runbook — Stripe products/webhook,
Google OAuth client, Resend, and Cloudflare Access for the admin subdomain:
see [`docs/wave4-auth-billing.md`](docs/wave4-auth-billing.md). All of it
degrades gracefully until configured, so this is optional for a first deploy.

## 3c. Worker usage profile
Production `wrangler.toml` is tuned for the Workers paid plan:

```toml
[limits]
cpu_ms = 300_000
subrequests = 10_000
```

The app still keeps its own guardrails. `/api/admin/securities/import` uses
`IMPORT_MAX_*` vars so sibling apps can send larger paid-plan batches without
turning a malformed import into runaway CPU/DB work. To run a leaner profile
later, lower the `IMPORT_MAX_*` vars and lower or remove the `[limits]` block.
The functional code path stays the same; only batch size/ceiling changes.

> **Migrations don't auto-apply.** Code auto-deploys (Cloudflare Workers
> Builds on push to `main`), but D1 migrations do **not** run as part of that.
> This account deliberately avoids `wrangler d1 migrations apply DB --remote`
> because its remote migration log can lag the real schema and replay old
> `ALTER TABLE` statements. Production schema is applied through the Worker
> binding instead:
>
> - `ADMIN_TOKEN=... bash scripts/ship.sh`, or
> - `curl -X POST https://<host>/api/admin/migrate -H "authorization: Bearer $ADMIN_TOKEN"`
>
> The admin migration endpoint is idempotent and skips "duplicate column" /
> "already exists" cases. Keep its statement list in `src/admin/routes.ts` in
> sync when you add a migration file. `npm run deploy:full` aliases `ship.sh`;
> `npm run migrate:remote` is intentionally disabled.

## 4. (Optional) Seed ticker resolution
The normalizer resolves tickers against the `securities_master` table; unresolved
tickers still pass through but with lower confidence. Load an equities list into
`securities_master(ticker, name, aliases)` for best results (any source — e.g. a
CSV of listed symbols imported via `wrangler d1 execute`).

## 5. Hybrid backfill ("instant history")
After deploy, seed historical trades from the free open datasets
(house/senate-stock-watcher), written as `source='seed_dataset'`, idempotent:
```bash
curl -X POST https://<your-worker-host>/api/admin/backfill \
  -H 'content-type: application/json' \
  -d '{"chambers":["house","senate"],"sinceYear":2014}'
# add "dryRun":true to preview counts without writing
```
The live watcher/extractor is the "primary, low-latency" half; it later upgrades
provenance on records you care about.

## 6. Dev / deploy
```bash
npm run dev      # local worker + cron + queues
npm run deploy   # wrangler deploy
```
The Deno Deploy cron is cost-profiled (default **`free`**: every 5 minutes,
small queue claims, idle short-circuit). Set `CT_COST_PROFILE=paid` only while
on Pro if you need every-minute ticks (use `CT_*` names — Deno rejects custom
`DENO_*` env keys). Confirm with `GET /api/health` → `costProfile`. The watcher
still self-gates via `shouldPollNow` against `poll_config`. See
`docs/rollouts/2026-07-25-deno-deploy-cost-min.md` for free-tier knobs, the
deploy daily-cap, and optional Coolify-driven `POST /api/admin/runtime-tick`.

## Endpoint reference
Public API (`/api`):
- `GET /api/transactions?since=<cursor>&ticker=&member=&chamber=&type=&from=&to=&order=&limit=` — cursor feed (reconciliation backstop). `from=`/`to=` (YYYY-MM-DD) bound the trade date for rolling-window pulls; `order=asc` (default, oldest-first — page forward with the returned `cursor` as the next `since`) or `order=desc` (newest-first "latest trades" snapshot, pair with `from=`).
- `GET /api/stream?subscription=&token=&since=` — SSE live push (subscription secret required)
- `GET /api/filings/:docId`, `GET /api/members`
- `POST /api/subscriptions` — create and return the subscription secret once
- `GET/PATCH /api/subscriptions/:id` — secret-scoped management
- `GET /api/subscriptions` is disabled publicly; use the admin endpoint below.

Client API (`/api/client/v1`, shared by the PWA and SwiftUI app):
- `GET /api/client/v1/bootstrap`, `GET /api/client/v1/me`
- `GET /api/client/v1/feed?since=&limit=&ticker=&member=&chamber=&type=&from=&to=&order=`
- `GET/PUT /api/client/v1/preferences` — signed-in users only
- `GET /api/client/v1/subscriptions` — signed-in user's webhook/SSE configs
- `POST /api/client/v1/commands`, `GET /api/client/v1/commands/:id` — command/status gateway

Admin (`/api/admin`, bearer token or Cloudflare Access; fails closed unless configured):
- `GET/PUT /api/admin/poll-config`, `GET /api/admin/poll-config/aggressive`
- `GET /api/admin/review-queue`, `POST /api/admin/review/:docId` `{decision:'confirm'|'reject', edits?}`
- `GET /api/admin/sources/health`, `GET /api/admin/subscriptions`
- `POST /api/admin/backfill`

UI: `GET /` (dashboard) and `/admin`. `GET /health` → `{ok:true}`.

Admin custom domain: `admin.congress.trade` is routed to the same Worker. Protect
it with Cloudflare Access before exposing admin workflows there; see
`docs/wave4-auth-billing.md`.

## Pipeline (how a filing flows)
```
cron → watcher (House XML diff + Senate eFD) → INGEST_QUEUE
  filing.new   → fetcher    (raw → R2)
  filing.fetched → classifier (senate_html | text_pdf | scanned_pdf)
  filing.extracted → orchestrator → extractor pipeline → normalizer
        ├ confidence ≥ 0.85 → persist (source='primary') → DELIVERY_QUEUE
        └ below / invalid   → review_queue (held off the live feed)
  delivery.dispatch → webhook fan-out (HMAC) + SSE
```

## Notes / TODO before production
- **Branch protection/rulesets** should remain enforced on `main`: use PRs,
  require the `typecheck + test` check, and prohibit force pushes/deletions.
- **Senate eFD** scraping depends on the agreement-gate + CSRF flow; if Senate
  changes its markup, `src/ingestion/senateSource.ts` is the place to adjust.
- **House bulk XML** refreshes ~daily; `pollHouseLiveSearch()` overlays the
  intraday live-search result when enabled so newly filed House PTRs can appear
  before the next bulk XML refresh.
- **Vision model** id lives in `src/extraction/visionLlm.ts`; review that
  constant before changing extraction cost/quality.
- **Observability and Smart Placement** are configured in `wrangler.toml`.
  Dashboard-only changes will drift on the next deploy if the config is not kept
  in sync.
- Confirm the `SEED_SOURCES` URLs in `src/backfill/seed.ts` resolve (flagged in code).
