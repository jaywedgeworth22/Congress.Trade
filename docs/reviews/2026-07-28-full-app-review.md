# Full-App Review — 2026-07-28 (KIMI, 6-agent review team)

Six parallel read-only review lanes against `main` (~`44585d6`, post PR #1054; one lane pinned to `27ea8fa` superset state). Lanes: pipeline, web UX, iOS parity, interop, code/LLM efficiency, ops/CI. Findings deduplicated across lanes; every item was verified in code with file:line evidence — see lane sections for citations.

> Context: this follows the sync-5 review wave (#1050–1055: queue/cron, delivery, interop docs, web, iOS). This review looked for what remains.

---

## 🔴 Tier 0 — Security / actively broken money paths

| # | Finding | Lane | Effort |
|---|---------|------|--------|
| S1 | **Hardcoded paid-provider API keys committed to git** — Unusual Whales key in `app/scripts/hoard_unusual_whales.ts:6`, Quiver Quant key in `app/scripts/hoard_quiver_quant.ts:6` (committed in `f34d824`). **Rotate both keys immediately**, move to Infisical, replace with `resolveSecret(...)`. | Code/LLM | S |
| S2 | **iOS never observes async command results — delivery secret is unrecoverable.** Backend `POST /api/client/v1/commands` returns `202 {command: queued}` with no `result` (async since #1050). iOS decodes a top-level `result` that never arrives (`APIClient.swift:316-327`), never polls `GET /commands/:id` (`command(id:)` defined but never called). Premium users cannot obtain their SSE/webhook secret on iOS. Tests mock the pre-async contract, so they pass. Web dashboard has the same latent weakness (`dashboardHtml.ts:4781`). | iOS | M |
| S3 | **"View source filing" links in web UI all 404** — UI builds `/api/client/v1/documents/:docId/pdf` in 3 places (`dashboardHtml.ts:3794, :3954, :7969`); only `GET /api/documents/:docId/pdf` exists (`delivery/rest.ts:615`). Introduced by `90a62dd` (#912); locked in by a test asserting the wrong path (`ui/__tests__/dashboardHtml.test.ts:1325`). The most trust-building click in the product is dead since Jul 24. | Web | S |
| S4 | **`app/prod.env` committed** (tracked; contents are an ANSI dump of an Infisical CLI prompt — no live secrets found, but a `prod.env` filename is a magnet for a future real secret). Delete + gitignore `prod.env`/`*.env`. | Code/LLM + Ops | S |

## P0 — Pipeline reliability (silent data loss / dark watchdogs)

| # | Finding | Effort |
|---|---------|--------|
| P0-1 | **Deno prod cron silently drops 3 maintenance lanes** — `runScheduledTick` → `runMaintenancePipeline` passes none of the options (`deno/scheduledTick.ts:380-403`), so the **missed-filing watchdog** (`runDisclosureLatencyProbe`), parked-delivery re-dispatch, and usage-telemetry drain never run in prod. Only the legacy Cloudflare `scheduled()` path enables them. Pass the options in the Deno tick + log enabled lanes at startup. | S |
| P0-2 | **Deno durable queue wired to a stale, divergent handler copy** — `deno/runtimeHandlers.ts` imports from `queueHandlers.ts`, whose `handleDeadLetterMessage` (a) marks delivery DLQ rows `completed` (permanently abandoning webhooks) instead of `reconnectDeadLetteredOutbox` as `index.ts:273-280` does; (b) throws on ingest DLQ types, causing an **uncapped infinite retry loop** in `drainDurableQueue`'s `dead_letter_pending` branch. Delete the stale copy, reuse index.ts implementations, add a DLQ cycle cap. | S–M |
| P0-3 | **Watcher discovery rewrites every known filing on every poll** — `insertFilingIfNew` (`ingestion/watcher.ts:165-301`) has no already-known fast path: ~5 sequential Turso round trips × ~1–2k PTRs every poll. Pre-diff with one chunked SELECT, write only new/incomplete rows, batch the rest. | M |
| P0-4 | **Production Sentry is a no-op on Deno Deploy** — `#sentry` import maps to `deno/sentryDummy.ts` (passthrough + `console.error`). The 82 Sentry references in `index.ts` protect the legacy Workers runtime only. Wire `@sentry/deno` (or minimal envelope transport reusing `scrubSentryEvent`), or stopgap: route tick/queue failure bursts through `notifyAdmin`. | M (S stopgap) |
| P0-5 | **Deploy workflow hardcodes `CT_COST_PROFILE=paid`** — `deploy-deno.yml:140-157` validates `vars.CT_COST_PROFILE` then ignores it, always setting `paid` (1-min cron, drainLimit 25 — the config that burned a free-tier month in ~4 days per `docs/rollouts/2026-07-25-deno-deploy-cost-min.md`). Use the validated var. | S |
| P0-6 | **Sentry CI-report workflow watches nonexistent workflow names** — `sentry-ci-report.yml:52-61` lists `Deploy` (actual: `Deploy Deno`) and `Codex Autofix`; prod deploy failures produce no alert. Add a CI assertion that `workflow_run.workflows` names match real workflows. | S |

## P1 — Promptness, accuracy, cost of disclosure processing

| # | Finding | Effort |
|---|---------|--------|
| P1-1 | **No `ingest_status` short-circuits** — redelivered queue messages redo fetch, classification, and full LLM extraction (the outbox stale-`enqueued` 2h sweep legitimately redrives the chain). Add early-returns in fetcher/classifier/orchestrator based on status. Prevents multiplied LLM spend on crash/lease races. | S |
| P1-2 | **Free-tier drain budget → hours-long publication latency under burst** — 3 sequential ingest messages per filing × drainLimit 2 per 15-min tick; a 20-PTR burst ≈ 7.5h. `agreement.check`/`autopilot.tick` claims outrank live filings. Reserve ≥1 claim/tick for `filing.*`; consider bounded burst mode. | S |
| P1-3 | **Non-retryable fetch failures park filings in `error` forever** — a House PTR listed before its PDF uploads → 404 → stranded. Recovery endpoints exist but are manual-only. Treat 404 as retryable-with-backoff for young filings; add a bounded daily error-requeue lane. | S–M |
| P1-4 | **LLM: OpenRouter + direct-Anthropic extraction calls don't set `temperature`** (provider default 1.0; Gemini/batch paths use 0). Sampling variance manufactures cascade disagreement → more paid tier-2/3 reads. Add `temperature: 0`. | S |
| P1-5 | **LLM: agreement trio reads run sequentially** (`agreement.ts:768-788`) — sum-of-3 latencies against per-minute cron and 15-min claim lease. `Promise.all` the lineup. | M |
| P1-6 | **LLM: batch extraction drops the metadata-grounded prompt** (`batchExtract.ts:204-213`) — backfill and live reads of the same filing diverge. Thread `ExtractionPromptContext` into batch items. | S |
| P1-7 | **LLM/cost: direct-Anthropic path has no prompt caching, no structured output; truncation retry re-sends the whole PDF** (`anthropicVision.ts:106-177`). Add `cache_control`; ~90% input discount unclaimed. | M |
| P1-8 | **Classifier buffers the entire raw object (up to 25 MB) to sniff 256 KB** — add ranged `get` to the S3 shim. Each raw object is read from R2 ≥2× end-to-end. | S–M |
| P1-9 | **Doc-classifier tier 2 ships the entire PDF for a 32-token answer** (`docClassifier.ts:225-255`) — send page 1 or reuse stored annotations. | S |
| P1-10 | **Gemini key rotation retries every key on deterministic 4xx** (`visionLlm.ts:215-271`) — rotate only on 429/402/403-quota. | S |
| P1-11 | **No external pipeline-health signal** — uptime monitor checks only HTTP+DB. "Site up, no new trades for 36h" pages nobody. Add `/api/health/pipeline` (poll age per source, queue depth, DLQ count) + assert thresholds in `uptime-monitor.yml`. | M |

## P1 — Web UX / features

| # | Finding | Effort |
|---|---------|--------|
| W1 | **Asset & politician drawers have permanently dead "Performance" sections** — `PERF_GATE` hardcoded (`dashboardHtml.ts:7820, :7876`) though working endpoints exist and are never called (`/api/analytics/ticker/:ticker/backtest`, `/api/analytics/member/:filerId/performance`). Lazy-load like the trade drawer does. | M |
| W2 | **`?trade=` deep links die for trades not in the loaded feed window** — public `GET /api/client/v1/trade/:id` exists (`client/routes.ts:114-137`) and is never used by `openDeepLink`. Sharing is the organic growth loop. | S–M |
| W3 | **CSV export silently drops the politician filter** — `exportCsv()` forwards ticker/type/chamber but not `memberName` (`dashboardHtml.ts:8217-8224`); endpoint honors it. Silent wrong data for journalists/researchers. | S |
| W4 | **Stale Premium gating copy for CSV export** (export is free since #558): dead `gateRow` code + "CSV export (Premium)" toast contradict pricing copy. | S |
| W5 | **Committee-conflict flags: built, public, undiscoverable** — `GET /api/analytics/conflicts` computes members trading in sectors their committees oversee; zero UI references. Highest journalistic value view in the dataset. Add a Trends section. | M |
| W6 | **Delivery creation exposes 2 of 8 filter dimensions; no edit; no delivery-health visibility** — engine supports members/amounts/sides/sectors/marketCap; web form has tickers+chambers only. `update_subscription` can patch filters but no Edit action exists. Attempt status needs a small endpoint. | S–M (+M for health) |
| W7 | **No politician directory** despite public `GET /api/members` roster — "look up my representative" has no entry point. | M |
| W8 | **No date-range filter in feed UI** though `/api/transactions` supports `from`/`to`. | S–M |
| W9 | **RSS undiscoverable** — no `<link rel="alternate">` in head, no UI mention. | S |
| W10 | A11y quick wins: toast lacks `aria-live`; pricing plan cards are click-only divs on the money path. | S |

## P1 — iOS parity (beyond S2 above)

| # | Finding | Effort |
|---|---------|--------|
| I1 | **Member-name search broken** — iOS sends `member=` (exact bioguide match) for free-text names; backend needs `memberName=` (LIKE). "Pelosi" → empty feed. | S (iOS) |
| I2 | **iOS requests `sort=tx_date`; client API silently drops it** (`client/utils.ts:80-82` accepts only published/cursor; REST accepts tx_date). One-line backend fix. | S (backend) |
| I3 | **No historical pagination on iOS** — single snapshot ≤200 rows; client API feed has no `offset`/`nextOlderCursor` (roadmap P1.1 already specifies design). Backend + iOS. | L (M stopgap) |
| I4 | **Trade detail lacks performance vs S&P 500** — endpoint exists and is public. | S–M (iOS) |
| I5 | **Ticker detail thin vs web asset drawer** — rich analytics endpoint exists, public. | M (iOS) |
| I6 | **DTO drift** — Swift drops backend-sent fields: command `result`/`payload` (drives S2), `estValue`, member `district`/`committees`, entitlement trial/cancel fields; latent decode break: `ClientFeedResponse.total` non-optional but backend omits it on zero-delta polls. | S (iOS) |
| I7 | **Trends covers ~60% of web analytics** — missing party-split, sector/market-cap breakdown, member-performance, filing-lag, trending; rows not navigable. All endpoints public. | M–L (iOS) |
| I8 | **No billing management path** — only a link to site root; `start_checkout`/`request_export` commands return 501. Decide handoff vs native. | M/L |
| I9 | **Delivery member filter accepts free text that can never match** — needs name→bioguide resolution via `/api/members` or remove field. | M (iOS) |
| I10 | Deep-link hygiene: require `url.host == "auth"` before storing token; consider universal links. | S/M |

## P1–P2 — Interop / integrator experience

| # | Finding | Effort |
|---|---------|--------|
| X1 | **Webhook contract completely undocumented** — payload schema, `X-Signature` HMAC scheme, retry schedule, dedupe headers exist only in TypeScript source. Add OpenAPI 3.1 `webhooks:` or `docs/webhooks.md` with verification snippets. The biggest integrator friction point. | S–M |
| X2 | **No webhook test/ping event** — subscribers can't validate until a real (sporadic) trade arrives. Add `POST /api/subscriptions/:id/test` through the exact same dispatch path. | S |
| X3 | **Signature has no timestamp → replay exposure** — add `X-Delivery-Timestamp`, sign `t.body`, document 5-min tolerance (Stripe/GitHub convention). | S |
| X4 | **OpenAPI spec drift** — `/api/feed.xml` missing; 403 documented as 401; spec not served anywhere; no CI drift guard. Serve at `/api/openapi.yaml` + route-walk CI test. | M |
| X5 | **Rate limits invisible** — no `X-RateLimit-*` headers, budgets undocumented (20k rows/IP/day, export 30/10min, feed limit max 500…). Stamp headers + document. | S |
| X6 | **No bulk access to the transactions corpus** — well-built date-partitioned snapshot machinery exists but covers only market tables and is token-gated; CSV rescans per request. Extend snapshots to transactions+filings. | M |
| X7 | Dead seed-source defaults still shipped (House S3 403, Senate mirror 429s) — swap/remove defaults, fail fast with override guidance. | S |
| X8 | No consumer quickstart; vendored shared package (`CongressEventSchema`) is an unpublished validation SDK-in-waiting. | S |

## P2 — Ops / reliability / cost

| # | Finding | Effort |
|---|---------|--------|
| O1 | **Staging/preview deploys a different stack than prod** — Wrangler/D1/CF-queues preview vs Deno Deploy/Turso/shim prod. Preview-green can't catch the migration-riskiest code (shims, durable queue, cron wiring). Create a Deno Deploy preview app + preview Turso DB. | M |
| O2 | **No Turso backup/restore story, no rollback runbook** — `app/DEPLOY.md` wholly stale (describes deleted wrangler stack). Write `docs/runbooks/backup-restore.md` + rewrite DEPLOY.md + rollback section. | M |
| O3 | **No retention for `deno_runtime_queue`, `ingestion_outbox`, `delivery_outbox`** — completed rows accumulate forever. Add to `RETENTION_POLICIES` + mirror indexes into admin migrate list. | S |
| O4 | **R2 growth unbounded** — bulk snapshot runs never pruned; orphaned raw PDFs have no reaper. R2 lifecycle rule + weekly orphan reaper. | S/M |
| O5 | **House reconciler written but never scheduled, alert-only, and would false-positive** (compares normalized ISO date to raw `M/D/YYYY`). Normalize, wire into daily jobs, have it enqueue missed docs. | S |
| O6 | **No amendment/correction handling** — `INSERT OR IGNORE` on doc_id means republished filings are invisible; cross-doc amendments double-count. Record etag/content-length, re-extract on change; add `supersedes_doc_id` linkage. | M |
| O7 | Tick singleton lock TTL (2 min) < realistic watcher duration; renew between lanes. House bulk ZIP fetched every poll with no conditional request (ETag/If-Modified-Since). | S |
| O8 | Deploy-cap counts `skipped` runs toward the daily cap; scheduled cadence exactly equals cap. Count only `success`. | S |

## P2–P3 — Code efficiency / tests / hygiene

| # | Finding | Effort |
|---|---------|--------|
| C1 | **No end-to-end money-path test** — nothing drives watcher→fetch→classify→extract→normalize→publish→outbox→webhook against fixture PDF + real durable queue. The Deno-migration seams are exactly where unit mocks can't see. | M |
| C2 | **Extraction row schema triplicated by hand** (Gemini/OpenRouter/Mistral) and already drifting (5 vs 16 required fields). One shared schema-builder. Also duplicated constants/regexes across 4 vision extractors → `visionCommon.ts`. | S |
| C3 | **Same PDF parsed 3× per extraction** (doc-class signals, chunking pre-pass, Anthropic validation). Parse once, pass through `ExtractorInput`. | S |
| C4 | **`npm run migrate` is a stub** that `scripts/cloud-setup.sh` still calls — fresh dev envs silently get no local schema. | S |
| C5 | **Dead routers**: `app/src/app.ts` (31-line divergent duplicate of index.ts mounts, zero importers), `app/main.ts`, `app/shared.ts`. Delete. | S |
| C6 | **~35 committed scratch files** — root (`delete_revisions*.py`, `scratch.tsx`, `test.db`, `scout-state.json`, `tsconfig.*.tmp.json`, `old stuff to delete/`…) and app/ (`refactor.py` — a string-replace landmine, `patch_normalizer.py`, `query_*.ts`, `scratch_*.ts`, `bad_docs.json`, `pdf_files.txt` 368KB…). One hygiene PR + CI check rejecting new `*.patch`/`scratch_*`/`*.env`. | S |
| C7 | Migration numbering anomalies: duplicate 0041 files; 0061 mirrored in admin list but file missing; 0026–0028 absent. | S |
| C8 | Monolith modules (`admin/routes.ts` 8,977 lines; `dashboardHtml.ts` 8,870; `agreement.ts` 2,203) are merge-conflict magnets in a 5-agent fleet. Incremental extraction, opportunistic. | L |
| C9 | Root `deno.json`/`package.json` duplicate the app import map and drift (`@sentry/cloudflare ^10.63.0` vs `^10.66.0`). Single source in `app/`. | S |
| C10 | `ui/dashboardHtml.ts` covered by one test file; fork PRs get zero CI signal; bare `npm audit` gate unscoped; `package.json` description still says "Cloudflare Workers service". | S–M |

## Verified already-good (do not regress)

- Webhook at-least-once machinery (claim rows, dedupe headers, jittered backoff), gap-free resumable SSE, CORS whitelist, CSV formula-injection neutralization, delivery-time entitlement re-checks, per-target circuit breakers.
- Queue dedupe keys, lease fencing/heartbeat, AbortSignal propagation, exact-set publish CAS, both outboxes, Senate lookback + daily deep sweep, LLM budget caps + circuit breakers, admin intervention endpoints.
- LLM: strict `json_schema` for verified vendors, metadata-grounded prompts (live path), OpenRouter annotation caching, `extraction_runs` result cache, hard daily USD ceilings with idempotent settlement, truncation salvage, per-chamber PRIMARY/FAILOVER model slots.
- Migration discipline (admin statement list mirrored through 0063, readiness probes gating /api/health), ship.sh smoke checks, runner-policy CI enforcement (Mac runner ban is mechanical), D1/Turso budget governors, retention sweeps for telemetry tables.

## Suggested landing order

1. **S1** rotate committed keys (today) → **S2** iOS command polling (Premium money path) → **S3** PDF 404 fix (S)
2. **P0-2** DLQ stale handler copy → **P0-1** dark maintenance lanes → **P0-5/P0-6** deploy workflow + alert-name fixes (all S)
3. **P0-4** real Sentry on Deno → **P1-11** pipeline-health endpoint
4. **P1-1/P1-2/P1-3** pipeline short-circuits + drain priority + error requeue → **P0-3** watcher write amplification
5. **P1-4…P1-10** LLM cost/accuracy batch (mostly S)
6. **W1–W4, I1–I2** UX/parity quick wins → **X1–X3** webhook surface (S each)
7. Hygiene batch: **S4, C4–C7, O3, X7**
8. Structural: **O1** preview parity, **O2** backup runbook, **I3** pagination, **X6** bulk snapshots, **C1** E2E test, **C8** monolith splits
