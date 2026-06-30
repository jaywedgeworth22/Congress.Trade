# Congress.Trade

Cloudflare Workers service that ingests US congressional **STOCK Act** stock-trade
disclosures (House + Senate), extracts structured trade events, and pushes them to
clients via webhook / SSE / REST.

> This is the production Worker app. The original scaffold has grown into
> implemented ingestion, extraction, delivery, admin, auth, billing, analytics,
> enrichment, price-refresh, backfill, and UI surfaces. See `../AGENTS.md` for
> branch/worktree coordination rules before continuing work.
>
> PWA/iOS planning lives in `docs/mobile-app-roadmap.md`. It treats the planned
> Next.js/PWA and SwiftUI app as peer clients over one backend client API and
> command/status model, not as places to run scraping, provider credentials, or
> MCP orchestration.
>
> Cloudflare Worker service names: production is `congress-trade`; preview is
> `congress-trade-preview`. Some backing D1/R2/queue resources still use legacy
> `congress-feed-*` names and should not be renamed without a coordinated
> resource migration.

---

## Architecture

```
                 ┌──────────────┐   cron (* * * * *)
                 │  scheduled() │──────────────┐
                 └──────────────┘              ▼
                                        ingestion/watcher  (shouldPollNow gate)
                                               │  poll House + Senate indexes
                                               │  insert filings(new) + ingest_log
                                               ▼  enqueue filing.new
   ┌────────────────────────── INGEST_QUEUE ───────────────────────────┐
   │ filing.new   → ingestion/fetcher    (download raw → R2, status=fetched) │
   │ filing.fetched → ingestion/classifier (detect docKind, run extractor)   │
   │ filing.extracted → (persist chain)                                      │
   │ tx.persisted  → enqueue delivery.dispatch                               │
   └─────────────────────────────────────────────────────────────────┘
                                               │
        extractor pipeline (src/extractors)    │ normalizer (validate brackets,
        senateHtml | textPdf | visionLlm  ─────┤ resolve ticker, confidence,
        (ArbitratingExtractor wraps vision)    │ low-confidence → review_queue)
                                               ▼ persist transactions(cursor_seq)
   ┌──────────────────────── DELIVERY_QUEUE ──────────────────────────┐
   │ delivery.dispatch → delivery/webhook  (sign + POST, record deliveries) │
   └─────────────────────────────────────────────────────────────────┘
                                               │
                 fetch() Hono app ── /health ── /api (REST, SSE) ── /api/analytics ── /api/admin
```

### Data flow (end to end)

`watcher → fetcher → classifier → extractor → normalizer → persist → deliver`

1. **watcher** (cron, self-gated by `shouldPollNow`) discovers new filings, writes
   `filings(status=new)` + `ingest_log`, enqueues `filing.new`.
2. **fetcher** downloads the raw doc into **R2** (`RAW_FILES`), sets
   `raw_object_key`, status `fetched`, enqueues `filing.fetched`.
3. **classifier** inspects the raw object → `doc_kind`
   (`senate_html|text_pdf|scanned_pdf|unknown`), selects the matching extractor.
4. **extractor** (pluggable pipeline) parses rows into `ParsedTx[]`. The vision
   extractor can be wrapped by `ArbitratingExtractor` (primary + optional
   secondary, gated by `ARBITRATION_API_KEY` + flag).
5. **normalizer** validates STOCK Act amount brackets, resolves tickers against
   `securities_master`, computes confidence, routes low-confidence to
   `review_queue`, and persists `transactions` (assigning stable `row_key` +
   monotonic `cursor_seq`).
6. **persist** enqueues `delivery.dispatch` only for newly inserted rows.
7. **deliver** fans out to matching subscriptions (webhook signed with
   `WEBHOOK_SIGNING_KEY`; SSE live stream; REST `?since=<cursor_seq>` pull).

---

## Where each module lives

| Path | Owner | Responsibility |
|------|-------|----------------|
| `src/index.ts` | foundation | Worker entry: `fetch`/`scheduled`/`queue`; `/health` (impl); router mounts |
| `src/shared/types.ts` | foundation | Canonical types/enums, `QueueMessage`, `Env` |
| `src/shared/config.ts` | foundation | Poll schedule, `shouldPollNow` (DST-correct ET), get/set config + last poll |
| `src/shared/brackets.ts` | foundation | STOCK Act bracket set, `matchBracket`, `isValidBracket` |
| `src/shared/db.ts` | foundation | Typed D1 `get`/`all`/`run`/`batch` helpers |
| `src/shared/ids.ts` | foundation | `uuid`, prefixed/monotonic ids, R2 key builder |
| `src/extractors/types.ts` | foundation | `Extractor` interface, `ArbitratingExtractor`, `buildExtractorPipeline` |
| `src/ingestion/watcher.ts` | ingestion | Cron poll loop, source discovery, enqueue |
| `src/ingestion/fetcher.ts` | ingestion | Download raw disclosures → R2 |
| `src/ingestion/classifier.ts` | ingestion | docKind detection and extraction handoff |
| `src/extraction/senateHtml.ts` | extraction | Senate HTML extractor |
| `src/extraction/textPdf.ts` | extraction | Text-layer PDF extractor |
| `src/extraction/visionLlm.ts` | extraction | Vision/LLM extractor for scanned PDFs |
| `src/extraction/normalizer.ts` | extraction | Validate/normalize/persist `Transaction[]` |
| `src/delivery/webhook.ts` | delivery | Signed webhook dispatch + retry metadata |
| `src/delivery/sse.ts` | delivery | SSE streaming |
| `src/delivery/rest.ts` | delivery | Public REST/market/export API router |
| `src/delivery/subscriptions.ts` | delivery | Subscription CRUD + filter matching |
| `src/analytics/sql.ts` | analytics | Shared SQL fragments + common filter builder |
| `src/analytics/compute.ts` | analytics | Pure post-processing (bracket midpoint, lag stats) |
| `src/analytics/builders.ts` | analytics | Pure per-endpoint aggregation query builders |
| `src/analytics/routes.ts` | analytics | `/api/analytics/*` read API (KV-cached) |
| `src/admin/routes.ts` | admin | Secured admin operations, migrations, backfills, enrichment |
| `src/auth/` | auth | Google OAuth, magic-link email, KV sessions |
| `src/billing/` | billing | Stripe checkout, portal, webhook, entitlement |
| `src/enrichment/` | enrichment | SEC/FMP asset reference enrichment |
| `src/prices/` | prices | FMP EOD prices, S&P series, trade performance anchors |
| `src/backfill/` | backfill | Seed/open-data and House historical backfill |
| `src/ui/` | ui | Server-rendered dashboard/admin HTML and browser scripts |
| `../dashboard-design.html` | ui | Historical/static visual design artifact |

---

## Analytics API (`/api/analytics/*`)

Read-only trend aggregates over the transaction corpus — the data behind the
dashboard **Trends** tab. All are GET, public (no auth), and KV-cached for a few
minutes. Pure SQL builders live in `src/analytics/builders.ts` and are unit-tested
without a DB (mirroring `src/delivery/rows.ts`).

| Endpoint | What it answers |
|----------|-----------------|
| `GET /summary` | KPI strip: trades, politicians, assets, est. volume, net flow, buy pressure |
| `GET /ticker-leaderboard` | Most-traded tickers (sort `trades\|members\|volume\|netflow`) |
| `GET /member-leaderboard` | Most active politicians (sort `trades\|volume\|tickers`) |
| `GET /cluster-buys` | Consensus: ≥N distinct politicians trading the **same direction** |
| `GET /trending` | Momentum: tickers up most vs the prior equal period |
| `GET /volume-over-time` | Buys vs sells bucketed by day/week/month |
| `GET /party-split` | Buy/sell + net flow per party (D/R/Other) |
| `GET /sector-breakdown` | Volume by `asset_type` |
| `GET /filing-lag` | Disclosure timeliness distribution + slowest filers |
| `GET /ticker/:ticker` | Single-ticker deep dive (series, top buyers/sellers, recent) |

**Common query params:** `window=7d\|30d\|90d\|365d\|all` (default `30d`, by
`tx_date`), `chamber=house\|senate`, `party=D\|R\|O`, `source=all\|primary\|seed_dataset`
(default `all`), `minConf=0..1`, plus per-endpoint `limit` / `sort` / `granularity`
/ `minMembers`.

> **Dollars are estimates.** STOCK Act amounts are disclosed only as *brackets*,
> so every `$` metric uses the bracket **midpoint** (the open `$50M+` tier uses
> its floor) via the single `BRACKET_MIDPOINT_SQL` expression. With `source=all`
> a trade present in both the live and seed sets can be double-counted — use
> `source=primary` for a de-duplicated dollar view.

## Delivery subscriptions

Subscription ids are identifiers, not credentials.

- `POST /api/subscriptions` creates a webhook or SSE subscription and returns
  its generated secret exactly once. Store it immediately.
- `GET /api/subscriptions` is intentionally disabled publicly. Use
  `GET /api/admin/subscriptions` from the secured admin API for operator lists.
- `GET/PATCH /api/subscriptions/:id` require the per-subscription secret via
  `Authorization: Bearer <secret>` or `X-Subscription-Secret`. Responses redact
  the secret unless the request is explicitly rotating it.
- `GET /api/stream?subscription=<id>&token=<secret>` opens an SSE stream. Native
  browser `EventSource` cannot set authorization headers, so browser clients use
  a scoped query token and must treat stream URLs as sensitive.
- Webhook delivery is at-least-once. The Worker claims a unique
  `(subscription_id, tx_id)` row before POSTing, and recipients should still
  dedupe on `X-Subscription-Id` + `X-Tx-Id`.

Live normalization is also idempotent after migration `0008`: each primary row
gets a stable `row_key`, and D1 enforces unique `(doc_id, source, row_key)`.
Retries or duplicate queue messages should not create duplicate live rows or
duplicate delivery fan-out.

## Bindings (wrangler.toml)

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | Structured store (filers, filings, transactions, …) |
| `RAW_FILES` | R2 | Raw disclosure files (PDF/HTML) |
| `INGEST_QUEUE` | Queue | Pipeline stage hand-off |
| `DELIVERY_QUEUE` | Queue | Delivery fan-out |
| `CONFIG_KV` | KV | Hot config cache (poll schedule, last-poll timestamps) |

Local development variables are documented in `.dev.vars.example`; copy it to
`.dev.vars` and keep the real file untracked. Production provider/app secrets
should live in Infisical and be read at runtime through the machine-identity
resolver. Cloudflare Worker secrets should only need the Infisical bootstrap
identity credentials after cutover; provider-key Worker secrets are migration
fallback only. Important groups:

| Group | Variables |
|-------|-----------|
| Infisical bootstrap | `INFISICAL_APP_PROJECT_ID`, `INFISICAL_APP_CLIENT_ID`, `INFISICAL_APP_CLIENT_SECRET`, `INFISICAL_SHARED_PROJECT_ID`, `INFISICAL_SHARED_CLIENT_ID`, `INFISICAL_SHARED_CLIENT_SECRET`, `INFISICAL_ENV`, `INFISICAL_ALLOW_ENV_FALLBACK` |
| Admin | `ADMIN_TOKEN`, `INGEST_TOKEN`, `ADMIN_EMAILS`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, `ADMIN_OPEN_IN_DEV` |
| Extraction | `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ARBITRATION_API_KEY`, `ARBITRATION_ENABLED`, `ARBITRATION_MODEL` |
| Market data | `FMP_API_KEY`, `FMP_DAILY_CALL_CAP`, `SEED_HOUSE_URL`, `SEED_SENATE_URL`, `HOUSE_LIVE_SEARCH_ENABLED` |
| Delivery | `WEBHOOK_SIGNING_KEY` |
| Public auth/email | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `APP_BASE_URL`, `ALERT_EMAIL` |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`, `STRIPE_TRIAL_DAYS` |

The admin API fails closed unless `ADMIN_TOKEN` or Cloudflare Access is
configured. `ADMIN_OPEN_IN_DEV=true` is a local-only escape hatch.

---

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit (must be clean)
npm run test        # vitest run
npm run migrate     # apply D1 migrations locally
npm run dev         # wrangler dev
npm run deploy      # production Worker deploy using wrangler.toml
```

Deployment is automated via **Cloudflare Workers Builds** (connected to this
repo): pushes to `main` run `npm run build` then `npx wrangler deploy` with the
**Root directory** set to `app`. The production Worker service is
`congress-trade`. The real D1 `database_id` and `CONFIG_KV` id are committed in
`wrangler.toml`; the queues (`congress-feed-ingest`,
`congress-feed-delivery`, + `*-dlq`) and the R2 bucket (`congress-feed-raw`) are
legacy backing-resource names and must already exist on the account. Runtime
secrets are set out-of-band via `wrangler secret put` and are NOT committed.

Plain deploys do not apply D1 migrations. Use the deployment runbook before any
schema change reaches production.
