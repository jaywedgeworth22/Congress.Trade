# Handoff — D1 read-cost control + Cloudflare-alternatives evaluation (MONET)

**Date:** 2026-07-18
**Seat:** MONET
**Branch:** `monet/d1-read-cost-control` (off `main`)
**PR:** #559 — https://github.com/jaywedgeworth22/Congress.Trade/pull/559
**Status:** Implemented, gates green, pushed, PR open. **NOT merged, NOT deployed** (owner gate).

---

## Why this work exists

The owner's Cloudflare **D1 bill overran a $10 budget**. Root cause: Cloudflare has **no hard spend cap** for Workers/D1 — the "$10 cap" was a **Budget Alert**, which the docs state is *"informational only … does not pause or cap usage."* It emailed once and charges kept accruing. The real driver is **D1 rows read/written** (D1 bills per row *scanned*, not returned), not the runtime.

The owner first asked to **evaluate migrating off Cloudflare** (Vercel/Netlify/Deno/Lambda@Edge/Deno Deploy/Northflank), then chose to do the **in-place fixes first** (items 1–4 below). A migration is still an open option (see "Evaluation summary" at the end).

---

## What shipped in PR #559 (items 1–4)

### 1. Index — the biggest read amplifier
- **`app/migrations/0044_tx_doc_index.sql`**: `CREATE INDEX IF NOT EXISTS idx_tx_doc ON transactions (doc_id)`.
- The only `doc_id`-leading indexes were **partial** uniques gated on `row_key IS NOT NULL`. SQLite won't use a partial index for a query it can't prove the predicate for, so the correlated `EXISTS / NOT EXISTS / COUNT(*) … WHERE doc_id = ?` dedupe/selector subqueries in `extraction/normalizer.ts`, `extraction/agreement.ts` (lease-acquire + autopublish selector), and `ingestion/fmpDisclosureLatency.ts` **full-scanned `transactions` once per outer cron row**. This collapses them to a seek.
- Mirrored into `POST_0024_SCHEMA_STATEMENTS` in `app/src/admin/migrations.ts` (so `POST /api/admin/migrate` applies it) + updated the strict parity test `app/src/admin/__tests__/migrations.test.ts`.
- Added **`POST /api/admin/analyze`** (`app/src/admin/routes.ts`) — error-tolerant, operator-triggered one-shot `ANALYZE` via the D1 binding. **Deliberately NOT in `/migrate`**: `ANALYZE` reads rows (a cost we're cutting), would re-run every deploy, and a rejected statement 500s the whole migration. A single-column equality index is used by the planner without stats anyway.

### 2. Caching — stop re-scanning per request
- Analytics KV cache TTLs raised in `app/src/analytics/routes.ts`: leaderboards/rollups `300→900s`, deep-dive pages `300→600s`, `/filing-lag` `600→1800s`, `/summary` `60→120s`.
- Lifted `cached()`/`cacheKey()` into new **`app/src/shared/kvCache.ts`** and cached the previously-uncached full-corpus **`/api/members` GROUP BY** in `app/src/delivery/rest.ts` (no params → one key, 30-min TTL) — the single biggest uncached scan.

### 3. D1 row-budget guard — the enforceable ceiling (opt-in)
- The literal "put D1 on the **Free** tier" hard stop is **NOT viable**: the app requires Paid (`[limits] cpu_ms=300000`, Queues, Smart Placement), and D1's free caps are account-level (can't free-cap one DB while the Worker is Paid). This is the actionable equivalent.
- **`app/src/shared/d1Budget.ts`**: meters `D1Meta.rows_read`/`rows_written` at the single `app/src/shared/db.ts` choke point (`all`/`run`/`batch`), accumulates per isolate, flushes to KV day-counters (`d1:rows_read:YYYY-MM-DD` / `d1:rows_written:*`) at each entrypoint tail:
  - `fetch` — after the response settles (via `ctx.waitUntil`).
  - `scheduled` — after all cron tasks settle (added a `track()` helper + `Promise.allSettled(tasks)`).
  - `queue` — awaited inline at both exit points (DLQ branch + main).
- **Alert (default, always on):** soft-warns to console + Sentry at 80% of budget.
- **Enforce (opt-in, default OFF):** `D1_ROW_BUDGET_ENFORCE` truthy → the discretionary daily enrichment/price/backfill jobs (`app/src/jobs.ts` `maybeRunDailyJobs`) self-abort when over budget. Never gates health/auth/billing/delivery/read path.
- **Fails open everywhere.** `get()`/`.first()` point reads carry no `D1Meta` and are intentionally unmetered (their expensive cases are handled by the index + caching).
- New Infisical-tunable config (declared in `app/src/shared/types.ts`): `D1_DAILY_ROWS_READ_BUDGET` (default 200,000,000/day — reads are cheap; this is an anomaly tripwire), `D1_DAILY_ROWS_WRITTEN_BUDGET` (default 2,000,000/day ≈ ~$10/mo of D1 writes), `D1_ROW_BUDGET_ENFORCE` (default off).

### 4. Observability — kill the relentless log volume
- `app/wrangler.toml`: `invocation_logs = false` + logs `head_sampling_rate` `1 → 0.1` (traces left at 0.05).
- The dominant steady cost was the automatic per-invocation log at 100% across the per-minute cron (~43.8k mostly-no-op invocations/mo) + every fetch/queue call. Sentry already captures errors (`captureException` + console warn/error integration) and cron health (`Sentry.withMonitor`), so error visibility is preserved. ~10× fewer billed log events.

---

## Gates
- `cd app && npm run typecheck` — **clean**.
- `cd app && npm test` — **135 files / 1,420 tests pass**.
- NOTE: this worktree had no `node_modules`; ran `npm ci` (installs the `github:` shared dep via the machine's git creds).
- Did **not** drive a live `wrangler dev` Worker end-to-end. The vitest suite is the project's verification harness: the migration **parity + schema-snapshot** tests apply the migration to in-memory SQLite and assert the index is produced; the queue/fetcher tests exercise the new `db.ts` metering. If belt-and-suspenders is wanted before merge, spin up miniflare/wrangler with bindings.

---

## To apply AFTER merge (production actions — owner-gated)
1. Deploy `main` (auto-deploy per standing owner directive).
2. `POST /api/admin/migrate` (admin token + browser UA) to create `idx_tx_doc`.
3. Optional: `POST /api/admin/analyze` once to refresh planner stats (whole-DB, or `{ "table": "transactions" }`).
4. Watch D1 **Row Metrics** for a few days; calibrate `D1_DAILY_ROWS_*_BUDGET` in Infisical against observed numbers, then optionally set `D1_ROW_BUDGET_ENFORCE=true` to arm the hard stop.

---

## Open follow-ups (intentionally NOT in this PR)
- Cache the client `/api/client/v1/{ticker,member}` all-time summaries (`app/src/client/queries.ts` `tickerSummarySql`/`memberSummarySql`) and the unindexable public feed `COUNT` (`app/src/delivery/rows.ts:472`) + `sort=published` snapshot. Smaller wins; the feed path has a per-IP row-budget side effect (`spendRowBudget`) that must stay OUTSIDE any cached closure.
- Meter the 4 raw `env.DB.prepare`/`.batch` sites that bypass `shared/db.ts` (`admin/routes.ts`, `prices/service.ts`, `enrichment/service.ts`, `shared/thirdPartyTelemetry.ts`) for fuller write coverage. `admin/routes.ts` is the biggest (backfills).

---

## Coordination
- Disjoint from **AG PR #557** (D1 *writes* / ingestion UPDATEs) and **#555** (deploy split). Stayed off the ingestion UPDATE path.
- Claim + closeout posted in `#agent-sync` (`[Congress.Trade] MONET`).
- Effort-log closeout added to `docs/EFFORT-LOG.md` (top of `## Deployed`, marked PR OPEN).

---

## Evaluation summary (migrating off Cloudflare) — for future reference
Full research was done on Vercel Edge, Netlify Edge, Deno runtime (self-host), AWS Lambda@Edge, Deno Deploy, Northflank. Key conclusions:
- **The problem is the database, not the compute.** Most "edge function" alternatives pair with another *usage-metered* DB (Neon/Deno KV/DynamoDB on-demand) → same uncapped risk, just relocated.
- **The app is backend-shaped** (per-minute cron + queues + heavy sequential D1 + long LLM calls), so pure edge-function platforms (25–50ms CPU, no cron) don't fit.
- **Only structural fix for a true ceiling = flat-provisioned resources.** `Deno Deploy Pro` has a real configurable "$X → 403" cap (but takes the app OFFLINE at the cap and native KV is not relational). Vercel's Spend Management is real but **excludes the Marketplace DB** (verified). Northflank + self-hosting are flat-provisioned (predictable by construction).
- **Owner's own infra (Coolify + Hetzner) is the strongest true-cap option.** Note: **D1 is only reachable via the Workers binding**, so you can't leave Workers and keep D1 — the DB must move too. Recommended shape if migrating: **move BOTH compute + DB to a co-located Coolify container** (keep **SQLite** — D1 is SQLite underneath, so minimal port; no Durable Objects / Workers AI lock-in; Hono already runs on Node). "Move just the DB, keep Workers" is possible (external Postgres via Hyperdrive) but it's the awkward middle — cross-internet latency on the app's many sequential per-request queries, plus you still do the full SQLite→Postgres port.
- **Not urgent:** PR #559's fixes should hold the bill under budget on Cloudflare. Migration is only worth it for a *structural* guarantee (a bill that physically can't exceed the box price).

---

## Key file map (this PR)
```
app/migrations/0044_tx_doc_index.sql          new — the index
app/src/admin/migrations.ts                    +TX_DOC_INDEX_SCHEMA_STATEMENTS (admin-tail mirror)
app/src/admin/__tests__/migrations.test.ts     parity-test literal updated
app/src/admin/routes.ts                        +POST /api/admin/analyze
app/src/analytics/routes.ts                    cache TTLs raised; cached()/cacheKey() now imported
app/src/shared/kvCache.ts                      new — lifted cache helper
app/src/delivery/rest.ts                       /api/members now cached
app/src/shared/d1Budget.ts                     new — the meter + budget guard
app/src/shared/db.ts                           recordD1Meta() wired into all/run/batch (null-safe)
app/src/index.ts                               flushD1Budget() at fetch/scheduled/queue tails
app/src/jobs.ts                                isD1RowBudgetExceeded() gate in maybeRunDailyJobs
app/src/shared/types.ts                        +3 Env config fields
app/wrangler.toml                              observability: invocation_logs=false, head_sampling_rate 1→0.1
docs/EFFORT-LOG.md                             closeout entry
```
