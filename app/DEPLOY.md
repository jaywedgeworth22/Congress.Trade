# Deploy runbook — Congress.Trade

Congress.Trade ingests public US STOCK Act disclosures (House, Senate, and
Executive Branch), extracts/normalizes trades, and pushes them to clients via
webhook + SSE, with a dashboard and admin panel.  Live site:
[https://congress.trade](https://congress.trade).

Production is **not** a Cloudflare Worker and does **not** use D1.  The app
in this directory is a Deno process in the Coolify `congress-app` container
on `fleet-hetzner-nbg1`.  Coolify builds `app/docker-compose.yml` on push to
`main`.  Structured data is the host SQLite file at
`/data/congress-trade/db.sqlite`.  Deno KV is `/data/congress-trade/kv.sqlite`.
Filing PDFs are Cloudflare R2.  Cloudflare DNS/edge sit in front of the host.

There is no production `wrangler.toml`.  Treat `scripts/ship.sh` and
`POST /api/admin/migrate` as production operations.  `npm run deploy` only
prints that Coolify owns the publish step.

`app/scripts/deploy-preview.sh` is leftover isolated Wrangler preview
tooling.  It is not the live site and must not be pointed at
`congress.trade` or the production SQLite file.

## 0. Prerequisites

- Node 18+ and npm for local `typecheck` / `test`.
- Deno for the production entrypoint (`src/deno/main.ts`).
- Infisical machine-identity credentials (Coolify runtime env / `app/.dev.vars` locally).
- `cd app && npm install`.
- Verify locally before merging: `npm run typecheck && npm run test`.

## 1. Production host (already provisioned)

Do not run Cloudflare `wrangler d1 create` / `kv namespace create` /
`queues create` against this product.  Those commands provisioned the
retired Worker stack.

Live resources:

| Resource | Where |
|----------|--------|
| HTTP app | Coolify service `congress-app`, `127.0.0.1:5000` behind Traefik |
| SQLite | `/data/congress-trade/db.sqlite` on `fleet-hetzner-nbg1` |
| Deno KV | `/data/congress-trade/kv.sqlite` |
| Queues | SQLite table `deno_runtime_queue`, polled in-process |
| Filing PDFs | Cloudflare R2 (`RAW_FILES` S3 shim) |
| DB replica | Litestream → Backblaze B2 (`app/litestream.yml`) |
| Public hostname | `https://congress.trade` |

`scripts/provision.sh` is Worker-era.  Read the header before touching it.
Production schema still goes through `scripts/ship.sh` /
`POST /api/admin/migrate`.

## 2. Apply the database schema

```bash
# local leftover helper (Wrangler D1 --local).  Not production.
npx wrangler d1 migrations apply DB --local
# production (idempotent migrate against the live Coolify app)
ADMIN_TOKEN=... bash scripts/ship.sh
```

`ship.sh` does **not** publish a Worker.  Coolify already redeploys on
`main`.  The script waits until `GET https://congress.trade/api/health`
reports the current HEAD SHA, then POSTs `/api/admin/migrate`.

This creates all tables and seeds `poll_config` row 1 with the default adaptive
schedule (Mon–Fri 08–19 ET = 300s, evenings = 1200s, weekends = 3600s).

## 3. Secrets and vars

Infisical is the source of truth.  Coolify should store the Infisical
machine-identity bootstrap credentials and the host SQLite URL override
`TURSO_DATABASE_URL=file:/data/congress-trade/db.sqlite`.  Do not
`wrangler secret put` production keys.

The app reads provider/app secrets from Infisical at runtime and caches them
briefly.  Existing env copies may remain as compatibility fallback while
`INFISICAL_ALLOW_ENV_FALLBACK` is not `"false"`.

Arbitration is **off** until `ARBITRATION_ENABLED = "true"` is present (set it
in Infisical or `.dev.vars`).  For local dev, run `bash scripts/cloud-setup.sh`
from the repository root; do not copy the reference `.dev.vars.example`
template.

Admin auth fails closed by default.  Set `ADMIN_TOKEN` or configure Cloudflare
Access (`ADMIN_EMAILS`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`) in front of the
admin surface.  Only local development should use `ADMIN_OPEN_IN_DEV="true"`.

## 3a. Sentry error monitoring

Sentry is configured through Infisical (`SENTRY_DSN`,
`SENTRY_ENVIRONMENT`).  The production Deno entry does not use Wrangler
secrets.  Get the DSN from Sentry → Projects → congress-trade → Settings →
Client Keys.  Local dev reads overrides from `app/.dev.vars`.

## 3b. End-user auth + Stripe paywall (Wave 4)

The public-site account system and freemium paywall have their own runbook —
Stripe products/webhook, Google OAuth, Resend, and Cloudflare Access for the
admin hostname: see [`docs/wave4-auth-billing.md`](docs/wave4-auth-billing.md).
All of it degrades gracefully until configured.

## 3c. Runtime cost profile

Production Coolify sets `CT_COST_PROFILE=paid` so in-process cron can tick
every minute.  The code default remains `free` if unset.  Confirm with
`GET /api/health` → `costProfile`.  The watcher still self-gates via
`shouldPollNow` against `poll_config`.

> **Migrations don't auto-apply.**  Code auto-deploys (Coolify docker-compose
> on push to `main`), but schema does **not** run as part of that.
>
> - `ADMIN_TOKEN=... bash scripts/ship.sh`, or
> - `curl -X POST https://congress.trade/api/admin/migrate -H "authorization: Bearer $ADMIN_TOKEN"`
>
> The admin migration endpoint is idempotent and skips "duplicate column" /
> "already exists" cases.  Keep its statement list in `src/admin/routes.ts` in
> sync when you add a migration file.  `npm run deploy:full` aliases `ship.sh`;
> `npm run migrate:remote` is intentionally disabled.

## 4. (Optional) Seed ticker resolution

The normalizer resolves tickers against the `securities_master` table;
unresolved tickers still pass through but with lower confidence.  Load an
equities list into `securities_master(ticker, name, aliases)` for best
results (admin import or local SQL).

## 5. Hybrid backfill ("instant history")

After deploy, seed historical trades from the free open datasets
(house/senate-stock-watcher), written as `source='seed_dataset'`, idempotent:

```bash
curl -X POST https://congress.trade/api/admin/backfill \
  -H 'content-type: application/json' \
  -d '{"chambers":["house","senate"],"sinceYear":2014}'
# add "dryRun":true to preview counts without writing
```

Do not run production backfill unless Jay explicitly asks.

## 6. Dev / deploy

```bash
npm run dev      # local Deno server
npm run deploy   # reminder only — Coolify publishes on main
ADMIN_TOKEN=... bash scripts/ship.sh   # wait for live SHA + migrate
```

Confirm with `GET https://congress.trade/api/health` → `ok` / `db` true and
a `build.sha` that matches the intended commit.

## Endpoint reference

Public API (`/api`):
- `GET /api/transactions?since=<cursor>&ticker=&member=&chamber=&type=&from=&to=&order=&limit=` — cursor feed (reconciliation backstop).  `from=`/`to=` (YYYY-MM-DD) bound the trade date for rolling-window pulls; `order=asc` (default, oldest-first — page forward with the returned `cursor` as the next `since`) or `order=desc` (newest-first "latest trades" snapshot, pair with `from=`).
- `GET /api/stream?subscription=&token=&since=` — SSE live push (subscription secret required)
- `GET /api/filings/:docId`, `GET /api/members`
- `POST /api/subscriptions` — create and return the subscription secret once
- `GET/PATCH /api/subscriptions/:id` — secret-scoped management
- `GET /api/subscriptions` is disabled publicly; use the admin endpoint below.

Client API (`/api/client/v1`, shared by the website and SwiftUI app):
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

UI: `GET /` (dashboard) and `/admin`.  `GET /health` → `{ok:true}`.

Admin hostname `admin.congress.trade` is DNS/edge in front of the same Coolify
app.  Protect it with Cloudflare Access before exposing admin workflows there;
see `docs/wave4-auth-billing.md`.

## Pipeline (how a filing flows)

```
cron → watcher (House XML diff + Senate eFD) → deno_runtime_queue (ingest)
  filing.new   → fetcher    (raw → R2)
  filing.fetched → classifier (senate_html | text_pdf | scanned_pdf)
  filing.extracted → orchestrator → extractor pipeline → normalizer
        ├ confidence ≥ 0.85 → persist (source='primary') → deno_runtime_queue (delivery)
        └ below / invalid   → review_queue (held off the live feed)
  delivery.dispatch → webhook fan-out (HMAC) + SSE
```

## Notes

- **Branch protection/rulesets** should remain enforced on `main`: use PRs,
  require the `typecheck + test` check, and prohibit force pushes/deletions.
- **Senate eFD** scraping depends on the agreement-gate + CSRF flow; if Senate
  changes its markup, `src/ingestion/senateSource.ts` is the place to adjust.
  Datacenter egress uses the named relay `https://scout.jays.services`.
- **House bulk XML** refreshes ~daily; `pollHouseLiveSearch()` overlays the
  intraday live-search result when enabled so newly filed House PTRs can appear
  before the next bulk XML refresh.
- **Vision model** id lives in `src/extraction/visionLlm.ts`; review that
  constant before changing extraction cost/quality.
- Confirm the `SEED_SOURCES` URLs in `src/backfill/seed.ts` resolve (flagged in code).
