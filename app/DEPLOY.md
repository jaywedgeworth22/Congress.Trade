# Deploy runbook — congress-feed

Cloudflare Workers service that ingests US congressional STOCK Act disclosures
(House + Senate), extracts/normalizes trades, and pushes them to clients via
webhook + SSE, with a dashboard and admin panel. This runbook takes a fresh
Cloudflare account to a running deployment.

## 0. Prerequisites
- Node 18+ and npm.
- A Cloudflare account; `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
- `cd app && npm install`.
- Verify locally before deploying: `npm run typecheck && npm run test` (95 tests).

## 1. Provision Cloudflare resources
Run from `app/`. Each command prints an ID — copy it into `wrangler.toml`.

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

Then edit `wrangler.toml` and replace the two placeholders:
- `database_id = "PLACEHOLDER_D1_DATABASE_ID"`
- `id = "PLACEHOLDER_KV_NAMESPACE_ID"` (the CONFIG_KV binding)

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
- `GET /api/stream?subscription=&since=` — SSE live push
- `GET /api/filings/:docId`, `GET /api/members`
- `GET/POST /api/subscriptions`, `GET/PATCH /api/subscriptions/:id`

Admin (`/api/admin`, bearer-auth stub — set `ADMIN_TOKEN` and enforce before prod):
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
- **Admin auth** is a documented stub (open unless `ADMIN_TOKEN` set); enforce it.
- **Senate eFD** scraping depends on the agreement-gate + CSRF flow; if Senate
  changes its markup, `src/ingestion/senateSource.ts` is the place to adjust.
- **House bulk XML** refreshes ~daily; the intraday live-search hook
  (`pollHouseLiveSearch()`) is stubbed for when you want sub-day House latency.
- **Vision model** id is `gemini-2.0-flash` in `src/extraction/visionLlm.ts` —
  bump to the current Flash model as needed.
- Confirm the `SEED_SOURCES` URLs in `src/backfill/seed.ts` resolve (flagged in code).
