# Deploy runbook — congress-feed

Cloudflare Workers service that ingests US congressional STOCK Act disclosures
(House + Senate), extracts/normalizes trades, and pushes them to clients via
webhook + SSE, with a dashboard and admin panel. This runbook takes a fresh
checkout to a running deployment.

`wrangler.toml` in this repository currently contains the live `congress.trade`
custom domains and real Cloudflare resource IDs. Treat `npm run deploy`,
`npm run deploy:full`, `scripts/ship.sh`, and remote D1 commands as production
operations unless you have intentionally changed the config or selected another
environment.

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
resources, patches placeholder IDs when present, and applies remote migrations.

## 2. Apply the database schema
```bash
# local (for `wrangler dev`)
npx wrangler d1 migrations apply DB --local
# production
npx wrangler d1 migrations apply DB --remote
```
This creates all tables and seeds `poll_config` row 1 with the default adaptive
schedule (Mon–Fri 08–19 ET = 300s, evenings = 1200s, weekends = 3600s).

## 3. Secrets and vars
```bash
npx wrangler secret put GEMINI_API_KEY        # vision OCR for scanned/handwritten House PTRs
npx wrangler secret put WEBHOOK_SIGNING_KEY   # default HMAC key for outbound webhooks
# optional — second OCR provider for dual-extractor arbitration:
npx wrangler secret put ARBITRATION_API_KEY
```
Arbitration is **off** until both the key above is set **and** the var
`ARBITRATION_ENABLED = "true"` is present (set it in `wrangler.toml` `[vars]` or
`.dev.vars`). Flipping it on makes the vision extractor run primary + secondary
and reconcile. For local dev, copy `.dev.vars.example` → `.dev.vars`.

Admin auth fails closed by default. Set `ADMIN_TOKEN` or configure Cloudflare
Access (`ADMIN_EMAILS`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`). Only local
development should use `ADMIN_OPEN_IN_DEV="true"`.

## 3b. End-user auth + Stripe paywall (Wave 4)
The public-site account system (Google OAuth + email magic-link) and freemium
paywall (Stripe) have their own copy-paste runbook — Stripe products/webhook,
Google OAuth client, Resend, and Cloudflare Access for the admin subdomain:
see [`docs/wave4-auth-billing.md`](docs/wave4-auth-billing.md). All of it
degrades gracefully until configured, so this is optional for a first deploy.

> **Migrations don't auto-apply.** Code auto-deploys (Cloudflare Workers
> Builds on push to `main`), but D1 migrations do **not** run as part of that.
> After any deploy that adds a migration, apply it or the new code will query
> tables/columns that don't exist (→ HTTP 500). Two ways:
> - `cd app && npx wrangler d1 migrations apply DB --remote`, **or**
> - `curl -X POST https://<host>/api/admin/migrate -H "authorization: Bearer $ADMIN_TOKEN"`
>   — an idempotent endpoint that runs every `CREATE TABLE IF NOT EXISTS` / `ALTER`
>   (skips "duplicate column"/"already exists"), so it's safe to re-run and needs
>   no local checkout. Keep its statement list in `src/admin/routes.ts` in sync
>   when you add a migration file.
>
> `scripts/ship.sh` deploys and then calls the admin migration endpoint. Use it
> when you deliberately want that production path. `npm run deploy:full` uses
> remote Wrangler D1 migration first, then deploys.

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
The cron trigger fires every minute; the watcher self-gates via `shouldPollNow`
against `poll_config`, so polling cadence changes (admin panel) take effect
within ~60s without a redeploy.

## Endpoint reference
Public API (`/api`):
- `GET /api/transactions?since=<cursor>&ticker=&member=&chamber=&type=&limit=` — cursor feed (reconciliation backstop)
- `GET /api/stream?subscription=&token=&since=` — SSE live push (subscription secret required)
- `GET /api/filings/:docId`, `GET /api/members`
- `POST /api/subscriptions` — create and return the subscription secret once
- `GET/PATCH /api/subscriptions/:id` — secret-scoped management
- `GET /api/subscriptions` is disabled publicly; use the admin endpoint below.

Client API (`/api/client/v1`, shared by the PWA and SwiftUI app):
- `GET /api/client/v1/bootstrap`, `GET /api/client/v1/me`
- `GET /api/client/v1/feed?since=&limit=&ticker=&member=&chamber=&type=&from=&to=`
- `GET/PUT /api/client/v1/preferences` — signed-in users only
- `GET /api/client/v1/subscriptions` — signed-in user's webhook/SSE configs
- `POST /api/client/v1/commands`, `GET /api/client/v1/commands/:id` — command/status gateway

Admin (`/api/admin`, bearer token or Cloudflare Access; fails closed unless configured):
- `GET/PUT /api/admin/poll-config`, `GET /api/admin/poll-config/aggressive`
- `GET /api/admin/review-queue`, `POST /api/admin/review/:docId` `{decision:'confirm'|'reject', edits?}`
- `GET /api/admin/sources/health`, `GET /api/admin/subscriptions`
- `POST /api/admin/backfill`

UI: `GET /` (dashboard) and `/admin`. `GET /health` → `{ok:true}`.

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
- **House bulk XML** refreshes ~daily; the intraday live-search hook
  (`pollHouseLiveSearch()`) is stubbed for when you want sub-day House latency.
- **Vision model** id lives in `src/extraction/visionLlm.ts`; review that
  constant before changing extraction cost/quality.
- Confirm the `SEED_SOURCES` URLs in `src/backfill/seed.ts` resolve (flagged in code).
