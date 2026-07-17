# Congress.Trade Effort Log — cross-agent board
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board: this file
(mirror: docs/EFFORT-LOG.md in the repo). As of 2026-07-05.

2026-07-05 (CLAUDE next-wave) correction: the repo mirror `docs/EFFORT-LOG.md` at origin/main was
stale vs this live board — missing the CURSOR completed batch, both MONET sentry-ci-report
updates, and the #160 completion, so the GitHub Issues mirror still showed CURSOR tasks #149-#154
as open `state:planned` even though all six are done. A mirror-sync commit lands this on
`claude/board-nextwave-c2` so the next Effort Issues Sync run closes #149-#154 and re-labels
#155/#161.

## Deployed
- **Optimize visionLlm PDF Chunking (AG) — DEPLOYED / LIVE VERIFIED 2026-07-17 via PR #541.** Bypasses PDF page-splitting chunking for all modern massive-context window models (all Gemini, Claude 3+, GPT-4o+, and OpenRouter models) to utilize native processing. Raises the default chunk threshold from 15 to 50 pages for older/non-massive models to reduce unnecessary segmentation. PR #541 squash-merged to `main` (all unit tests passed) and deployed to production via `ship.sh` with live health check verification.
- **Next.js PWA Dashboard Features Migration (AG) — DEPLOYED / LIVE VERIFIED 2026-07-17 via PR #538.** Migrated the column configuration, speed metrics latency scorecard (supporting equal-win "tied" states), and trade tables from the monolithic `dashboardHtml.ts` to modular Next.js PWA React components in `clients/pwa/app/ui/`. Features include SWR-driven telemetry fetching, client-side sorting, and local storage persistence. PR #538 squash-merged to `main` (all typechecks and tests passed) and deployed to production via `ship.sh` with live health check verification.
- **Refactor batchExtract.ts PDF upload concurrency (AG) — DEPLOYED / LIVE VERIFIED 2026-07-17 via PR #524.** Refactored PDF upload concurrency ceiling in `app/src/extraction/batchExtract.ts` from 5 to 25 for OpenAI and xAI batches. This provides a 5x throughput increase while safely staying within Cloudflare Workers' 50-subrequest ceiling with sufficient headroom for batch creation and JSONL uploads. Merged to `main` via PR #524 (all tests passed) and deployed to production via canonical `ship.sh` with live health check verification.
- **Speed Telemetry Panel Grid Redesign (AG) — DEPLOYED / LIVE VERIFIED 2026-07-17 via PR #516.** Implemented a visual overhaul of the "Speed vs. Data Providers" card. Replaced the rotating hero carousel with a static, side-by-side card grid showing metrics for all eligible latency providers (FMP, Unusual Whales, Quiver Quantitative) simultaneously to eliminate visual bias. Converted the layout to a stacked flex column to give the visual timeline race lanes the full width of the desktop dashboard card. Gated the typical lead metric by `SPEED_LANE_MIN_MATCHED` (5 filings minimum) to keep low-sample counts preliminary and consistent with the race lanes, and restored the `source` provenance column to `FEED_COLS` for admins. PR #516 merged, typechecks and tests passed, and shipped to production using canonical `ship.sh` with live health check verification.
- **LLM Payload Response Healing (AG) — DEPLOYED / LIVE VERIFIED 2026-07-17 via PR #514.** Ported the `jsonrepair` deterministic fallback logic from Socratic.Trade directly into `visionUtils.ts`. Now, when initial parsing or markdown-fenced string extraction fails, `extractJsonFallback` serves as a syntax-aware safety net to gracefully recover malformed, truncated, or conversational outputs. This provides client-side healing in conjunction with the provider-side `response-healing` plugin enabled earlier. Unit tests were added and run locally, and the PR was merged to main and pushed to production using `app/scripts/ship.sh`.
- **OpenRouter Response Healing Integration (AG) — DEPLOYED / LIVE VERIFIED 2026-07-16 via PR #506.** Enabled OpenRouter's `response-healing` plugin in `openRouterVision.ts` to automatically fix malformed JSON responses (missing brackets, trailing commas, markdown wrappers) directly on the provider side before hitting our parser. This drastically reduces expensive and unnecessary model failovers triggered by minor syntax errors. PR #506 merged, all tests passed, and canonical `ship.sh` deployed the Worker to production. Live-verified by reprocessing 2 recent House docs on production via `/api/admin/reprocess` which successfully parsed with Mistral OCR and returned 4 extracted rows perfectly matching the database with 0 errors.
- **Clean Company Name Standardization & Version Sync (AG, S) — DEPLOYED / LIVE VERIFIED 2026-07-16 via Congress.Trade PR #501 & Socratic.Trade PR #1686.** Bumps the `@jaywedgeworth22/congress-trading-shared` package to `fee9937c25db1de75c1a676826801e3399f36106` across both repos. Extends the `/securities/standardize-names` endpoint to query and clean the `ticker` as well as clean state suffixes, and normalizes the unstandardized names in both `securities_ref` and `transactions` tables. Restores the dashboard UI logic to correctly handle missing assets or matching tickers by rendering the enriched reference names.
- **UW trial full-utilization: 90-day coverage audit + deep-match probe pass (MONET, M, owner-directed) — AUDIT DELIVERED + PR #505 MERGED `642d265` / PRODUCTION DEPLOYED run 29560481847 / VERIFIED 2026-07-17 ~06:40 UTC.** Lane 1 (audit, no code): UW 90-day sweep (1,912 deduped rows) vs our /api/transactions (492) — T1/T2/T3 matches 323; **100% amount-bracket agreement** on all 310 matched groups; we lead filed-dates on 100% of pairs (median +1d); our extraction deeper (e.g. 103 vs 64 rows on the same filing). CRITICAL gaps found: senate ingestion nearly absent for the window (11 rows vs UW 152 — eFD blocking suspected), ~10 house members entirely missing (McCaul 41 rows), Cisneros July PTR missing; owner chip filed (ingestion coverage gaps). Reports: /Users/jay/apps/research/2026-07-16-uw-90day-coverage-audit.{md,json}; 48 UW requests spent. Re-run scheduled ~Jul 21 before trial end (Jul 22). Lane 2 (PR #505): bounded deep-match pass for stranded UW pending observations — tx-date-targeted recent-trades lookups (audit-verified `date` = transaction_date), rotation via attempts-tiebreak ordering, SQL-level transaction-eligibility filter before the scan cap, dedup'd pending accounting, DB-canonical first_observed_at, `UW_DEEP_MATCH_DATES_PER_RUN` knob (default 8), silent post-trial degradation. Seven codex-connector threads addressed+resolved properly (2×P1 + 5×P2, incl. wrong-date-targeting and backlog-starvation). Gates: typecheck + 132 files / 1,379 tests. Post-deploy: health green, latency-summary serving all 3 providers (Quiver race now 3–0).
- **#503 damage repair: red trunk + paused senate cascade + rate-card integrity (MONET, S) — PR #517 MERGED `7708194` / PRODUCTION DEPLOYED run 29560481847 / SENATE REVALIDATED 2026-07-17.** #503 ("remove non-sonnet 5 anthropic models") pointed five rate-card rows at `claude-sonnet-5` with four conflicting price sets, renamed the `claude-haiku-4-5` row (breaking historical cost decode), dropped haiku from DEFAULT_CANDIDATES (production senate trio → invalid → **senate agreement cascade paused fail-closed ~22:48Z Jul 16–06:40Z Jul 17**), left a literal duplicate sonnet-5 candidate (doubled paid fan-out calls), and narrowed the visionLlm massive-context match. Verified against Anthropic's pricing page (Sonnet 5 = $2/$10 intro through 2026-08-31, $3/$15 after — Sep-1 rollover chip filed) + OpenRouter live listing ($2/$10 passthrough). Fix: legacy row identities restored, ONE sonnet-5 row per transport, haiku restored to catalog (senate trio revalidated at deploy with owner-chosen voter — valid=true confirmed live), dedupe, massive-context covers all claude-sonnet gens. A real merge conflict vs main was resolved mid-flight (another lane independently landed the same test-expectation fix). Gates: full suite green ×2 (pre/post merge). Post-deploy Sentry: zero new issues.
- **Clean Company Name Formatting & Suffix Stripping (AG, S) — DEPLOYED / LIVE VERIFIED 2026-07-16 via PR #493 & shared library PR #193.** Refined the company name normalization logic in the shared library to strip state of incorporation suffixes (e.g. `/DE/`, `/CA/`, etc.) specifically using a predefined list of the 50 US state codes to prevent matching unrelated non-state suffixes. Updated both the backend client response mapping and the frontend dashboard UI mapping to prefer the clean, standardized company name (`refCompanyName`) from reference data over the raw parsed PDF name (`assetName`) when available.
- **Company Name Standardization Across Apps (AG, S) — DEPLOYED / LIVE VERIFIED 2026-07-16 via PR #488 & Socratic.Trade PR #1678.** Standardized company names properly across both Congress.Trade and Socratic.Trade via the `@jaywedgeworth22/congress-trading-shared` package, and updated the "Rising Activity" section to display the company name next to the ticker. Standardized the production D1 database and verified the live deploys for both apps.
- **Restore Quiver Quant + Unusual Whales to the public speed-vs-providers section (MONET, S, owner-directed) — PR #491 MERGED `2e19fab` / PRODUCTION DEPLOYED run 29535549681 / LIVE VERIFIED 2026-07-16 ~21:23 UTC.** Probe verified healthy FIRST (owner ask "ensure UW+Quiver fully utilized"): all 3 providers configured in prod — UW key was already provisioned in Infisical (`UNUSUAL_WHALES_API_KEY`), Quiver likewise; 0 probe errors; per-minute cron racing every filing. The comparison was missing from the site only because two client-side name-exclusion filters (speedEligible + renderSpeedProof in dashboardHtml.ts) deliberately hid Quiver/UW — removed, with test guards pinning no-exclusion; race-axis stops extended to 720h + scaling 48h-multiple fallthrough (codex P2 addressed by combining the codex-autofix commit `b1ddd9b` with the scaling fix `668ce4f`, thread resolved properly). Small samples ride the existing honesty rails (n<5 = counts only, no timing claim). Live numbers at deploy (last 62 filings/provider): FMP 33 matched we-first 32–1 median +1.6h · UW 10 matched 9–1 median +2.1 days · Quiver 2 matched 2–0 ~+15.5 min (provider-published timestamps); low UW/Quiver match rates = those feeds hadn't published most tracked filings at probe time. Gates: typecheck + full 132 files/1,372 tests. Post-deploy asserts: name filters absent from served page, trLatencySection + scaling fallthrough + 720h stops present, /api/analytics/latency-summary serving all 3 providers, health green.
- **Timeliness Panels UI Layout Improvements (AG, S) — DEPLOYED / LIVE VERIFIED 2026-07-16 via PR #483.** Improved the visual hierarchy and layout of the Disclosure Timeliness section. Constrained the Slowest Filers list wrapper to ~7 items with internal scrolling to prevent the container from stretching uncontrollably. Widened the gap spacing for the Lag Distribution bars, added "Days" and "Count" column headers for clarity, and increased font sizes and weight for better legibility while ensuring the distribution bars are vertically centered in the newly condensed grid space.
- **Header Tooling Clean: Redundant House + Senate Pill Removal (AG, S) — DEPLOYED / LIVE VERIFIED 2026-07-16 via PR #481.** Removed the redundant static "House + Senate" pill from the desktop header toolbar.
- **Trends Cards Alignment & Grid Proportion Tuning (AG, S) — DEPLOYED / LIVE VERIFIED 2026-07-16 via PR #477 & PR #478.** Centered all KPI values and sparklines vertically and horizontally inside trends page cards by making them flexbox containers globally and moving the sparklines HTML block inside the `.v` value container. Widened the "What Congress Is Trading" grid section to 1.25fr and narrowed the "Rising Activity" section to 0.75fr on desktop viewport width to prevent the Asset column (logos and tickers) from being truncated under narrow screen squeeze.
- **Unusual Whales Latency & Quality Integration (AG, S) — DEPLOYED / LIVE VERIFIED 2026-07-16 via PR #464.** Enabled and configured the 1-week trial Unusual Whales API key in the `dev` and `prod` Infisical environments as `UNUSUAL_WHALES_API_KEY`. Added `unusual_whales` to `DISCLOSURE_LATENCY_PROVIDERS` in `wrangler.toml` (running alongside `fmp` and `quiver`). Wired Unusual Whales into the `/api/admin/disclosure-latency/quality-crosscheck` report to parse and set-difference match transactions against our parsed database rows. Passed all 1352 tests and deployed live to production.
- **Dynamic Model Selection in Benchmark UI & OpenRouter Native PDF Ingestion (AG, S) — DEPLOYED / LIVE VERIFIED 2026-07-16.** Expanded the manual model re-read options with the full lineup of OpenRouter models. Injected a collapsible grid of checkboxes under "Custom Model Selection (for new runs)" in the benchmark toolbar. Updated `runChamberBenchmark()` and `runAllBenchmarks()` to read checked models to construct the payload for new benchmark runs, falling back to all models if none are checked. Maintained backward compatibility for resumed runs. Upgraded OpenRouter vision processing to transmit files natively using `type: "file"`. Switched to `main` worktree, merged PR #462, and executed canonical `app/scripts/ship.sh`. Appended a rule to `AGENTS.md` strictly prohibiting claims of completion without production deployment. All live validation checks passed.
- **Dashboard UI/UX and A11y Polish (AG, S) — DEPLOYED / LIVE VERIFIED 2026-07-15.** Reordered the `FEED_COLS` default layout to place the 'Traded' date at the far-left position. Enhanced the 'Latency' column to wrap cleanly on two lines for readability. Applied spring physics (cubic-bezier) animations to mobile drawer panels and dialogs, and implemented a `tickPop` ticker animation for feed count metrics. Verified that action badges (Buy/Sell/Exchange) correctly utilize semantic `<span>` tags instead of deprecated `<b>` tags for accessibility compliance. Owner also manually expanded the custom benchmark models list with OpenRouter and DeepSeek models (typechecked green). 
- **Deferred Audit Report Items (AG) — PLANNED/DEFERRED.** The following items from the comprehensive audit report remain deferred for future work:
  - **Backend:** Refactor sequential uploads in `batchExtract.ts` to use `Promise.all()` (High); Re-evaluate PDF chunking in `visionLlm.ts` to leverage large context windows/caching (Medium); Implement robust JSON parsing instead of regex in `visionLlm.ts` and `bakeoff.ts` (Medium); Address memory pressure in `textPdf.ts` and string manipulation overhead in `consensus.ts` (Low).
  - **Frontend:** Fix PWA mobile grid overflow and touch targets; migrate the 7,145-line `dashboardHtml.ts` logic to the modular Next.js PWA.
- **CLAUDE→MONET handoff tail: shared v1.8.0 consumption + workerd diagnostics root-cause (MONET, owner-directed 2026-07-15) — DEPLOYED / LIVE VERIFIED.** Second half of docs/handoffs/2026-07-15-claude-to-monet.md (#446 had auto-merged but sat undeployed; tail was unclaimed until this lane's #agent-sync sync-1 claim). Shared PR #190 un-drafted + squash-merged after AGENTS.md tokenless git-install smokes passed on branch head `95492c9` AND final main; annotated tag `v1.8.0` = `2b13da0`. CT PR #457 merged `f1df035`: root+app exact-commit pins → `2b13da0` (allowScripts-by-commit convention), app-local `Chamber` widening + `ClientTrade` Omit-pattern collapsed to plain shared re-exports (shared member.chamber already `Chamber|null`); gate 130 files/1,348 tests, run twice. ST twin PR #1641 merged same hour; Shared-package-pin-check workflow_dispatch on main: SUCCESS — v1.8.0 parity across both consumers. Prod deploy run 29460015907 (announce-then-deploy honored, no objections) shipped #446+#456+#457: `/api/health` ok/db/schema true, Zilla Slab wordmark serving; idempotent `POST /api/admin/oge-backfill` fired (ok:true, newFilings:0 — filer party/portrait upsert executed; ADMIN_TOKEN via Infisical universal-auth machine identity, shell-only, never printed). PR #456 fixed the workerd-diagnostics workflow (missing setup-node; first dispatch ran stock node10 and diagnosed nothing) — re-dispatch run 29447361749 CONFIRMED ROOT CAUSE of the runner `write EPIPE`: runner container is Ubuntu 20.04 glibc 2.31 but workerd needs ≥2.35 (ldd shows GLIBC_2.32–2.35 all missing; strace shows the loader killing workerd pre-main, so miniflare's stdin write hits a dead pipe → `reviewResolutionD1.test.ts` probe-skips on the runner while hosted CI stays green). FIX = rebuild the runner container on Ubuntu 24.04 (owner task chip filed with full spec; also flagged: the workflow's miniflare probe writes to /tmp so ESM resolution misses app/node_modules — fix alongside the image bump). Still open from the handoff (owner/ops decisions, deliberately not executed by this lane): needs_review backlog acceleration (AGREEMENT budget knob or uncapped agreement-reprocess), 21 deterministic hard-fail PDFs, 4 oversized executive mega-filings (`OGE_MAX_VISION_BYTES` probe), logo mark + domain registrations.
- **Provider Ingestion Quality Cross-Check & Crawler Backoff Fix (AG, S) — DEPLOYED / LIVE VERIFIED 2026-07-15 via PR #459.** Added `/api/admin/disclosure-latency/quality-crosscheck` endpoint that compares parsed transactions in our production D1 database against provider observations from FMP and Quiver to calculate our quality edge. Enabled Quiver Quant background latency polling by adding `DISCLOSURE_LATENCY_PROVIDERS = \"fmp,quiver\"` default to `wrangler.toml`. Discovered and fixed a major Senate HTML document fetch bug by attaching cached eFD session cookies from `CONFIG_KV` to avoid redirecting to the search agreement wall page. Implemented a polite 10-minute crawl failure backoff in `watcher.ts` using `last_attempt:${source}` KV keys to prevent infinite minute-by-minute retry loops when Senate eFD 403s/blocks Worker exit IPs. All 1352 tests passed.
- **Benchmark model-config redesign: unified A–E slots panel + catalog repair (MONET, M, owner-directed) — PR #473 MERGED `ccb3f1e` / PRODUCTION DEPLOYED run 29476767744 / LIVE VERIFIED 2026-07-16 ~06:31 UTC.** ROOT CAUSE of "benchmark is messed up": the benchmark config UI on main was hard-broken — `renderBenchmarkSettingsSummary()` invoked in 3 places but never defined (ReferenceError on benchmark-tab load) + two generations of dead panel code with save handlers shadowed by hoisted redefinitions targeting nonexistent containers/state; NO working path existed to set any model slot. Shipped: (1) unified per-chamber "Model slots (A–E)" panel (A Primary / B Failover / C–E agreement voters, one save flow → roles PUT + settings PUT, server validation surfaced verbatim, non-blocking tier-1-independence warning), dead code removed, `renderBenchmarkSettingsSummary` defined; (2) catalog repair — 14 openrouter slugs verified DEAD against the live OpenRouter models API removed (receipt table in PR), deepseek chat/coder → `deepseek/deepseek-v4-pro` + `v4-flash` (owner directive; both verified live; v4-flash via OR is ~30% under direct list), live cheap-vision candidates added (qwen3-vl-30b/8b, gemini-2.5-flash-lite, nova-lite-v1, glm-4.6v, gemini-3.5-flash-via-OR), GPT-4o retirement predicate extended to openrouter transport (closes #414-decision hole); (3) model menus/checkbox grid derived from `benchmarkModelCatalog()` server-side (hand-maintained duplicates killed); (4) `openrouter` added to the bakeoff provider allowlist (was 400ing every OR re-read). Gates: serialized full suite 132 files / 1,367 tests + typecheck; parent orphan-review clean. Live receipts: `slotModelA`/"Model slots (A–E)"/both deepseek-v4 slugs SERVE from production, `deepseek-coder` gone, /api/health green, Sentry no post-deploy regressions (6 pre-deploy operational issues noted: 3× one-off D1 storage timeouts ~5h prior, /api/stream N+1 + 2 slow-query perf detections, webhook-retry re-fire — all pre-date the deploy). Builds on AG's #460/#462 (preserved).
- **Anthropic BATCH-path per-item PDF pre-validation (MONET, S) — PR #472 MERGED `dafeab5` / PRODUCTION DEPLOYED run 29476767744 (with #473) 2026-07-16.** Closes the #461-documented gap: every doc is pre-validated with `validatePdfForAnthropic` before batch submission; invalid docs are EXCLUDED from the provider request and get a recorded `ok:false` BatchDocResult with the stable sync-path error string (identical providerFailure classification + review-queue routing); `batch_jobs.doc_ids` accounting stays consistent via a versioned `ct-batch-prevalidated-v1:` marker on `providerBatchId` decoded only in `pollAnthropic` (historical ids and all other consumers unaffected — only provider-facing consumer is pollBatch, parent-verified); all-invalid batches make zero provider calls at submit AND poll; valid docs send ORIGINAL bytes (no resave), batch 400s still fall back to the sync path's repair retry. Gates: full suite 132 files / 1,367 tests + typecheck. Two earlier builder attempts died on a transient API outage (no code landed) before the successful relaunch.
- **#453 Anthropic pdf-resave regression: found + fixed + deployed (MONET, S) — PR #461 MERGED `89588a7` / PRODUCTION DEPLOYED run 29462909860 / FIX VERIFIED LIVE 2026-07-16 ~01:10 UTC.** Owner-directed live model verification (canary cells on benchmark run `5b97aff0`, doc H-2026-20034954) surfaced that #453's `normalizePdfForAnthropic` substituted pdf-lib RESAVED bytes on every doc and Anthropic 400s ("The PDF specified was not valid") on PDFs it previously read fine (receipt: prior ok sonnet agreement read on the same doc; req_011Cd4nNWmv3LPBZwfys7KhM). Fix: validate-only fail-fast kept + ORIGINAL bytes primary + one-shot resave repair retry on the receipted 400 class (batch path was never resave-affected; its missing-validation gap → follow-up row above). Gates: typecheck clean + 132 files / 1,363 tests. Deploy also shipped AG's #460 (OpenRouter native PDF + benchmark models) per announced claim; post-deploy re-canary doc H-2026-20034928: sonnet ok 10 rows / haiku ok 10 rows. Same verification pass: gemini key 403 API_KEY_SERVICE_BLOCKED (owner notified — key restriction, not credits), llamaparse:fast systemic result-404s (persists post-#453 retry; keep out of trios), llamaparse:cost-effective under-extracted 6 vs 16-row consensus on the canary doc. Benchmark run `5b97aff0` driving + gemini/OpenRouter lane handed to AG per owner directive (research note: /Users/jay/apps/research/2026-07-15-openrouter-congress-trade.md); owner's manual trio config left untouched per owner instruction.
- **Evaluation + landing sweep closeout: per-chamber model-slot config migration + pipeline hardening (CLAUDE→MONET, L) — 2026-07-15.** CLAUDE half: PRs #442 (landing sweep: AG feed sort + CODEX cost visibility + PR #417 salvage), #447 (mobile feed sort), #448 (PWA delivery clarity + Executive filter), #449 (per-chamber PRIMARY/FAILOVER slots A/B + agreement trio→C/D/E + fenced `GET/PUT /api/admin/benchmark/roles/:chamber`) all merged + production-verified; PR #417 closed superseded (its secret-shaped files verified 0-byte, no exposure). MONET half (owner-directed handoff pickup): **production config migration COMPLETE 2026-07-15 ~19:00 UTC** via fenced admin PUTs (expectedVersion honored, no conflicts) — trio C/D/E = pre-migration live values (house `mistral:mistral-ocr-latest`/`llamaparse:cost-effective`/`anthropic:claude-sonnet-4-6` · senate `mistral:mistral-ocr-latest`/`llamaparse:fast`/`anthropic:claude-haiku-4-5` · executive `gemini:gemini-3.5-flash`/`anthropic:claude-sonnet-4-6`/`openai:gpt-5.6-terra`); roles A/B all chambers = primary `mistral:mistral-ocr-latest` / failover `openai:gpt-5.6-terra` per the 2026-07-15 benchmark evidence. Verified: all 3 chambers settings+roles `valid=true`, config-sources 15/15 `AGREEMENT_*_MODEL_{A..E}` from infisical, `/api/health` green, review-queue has zero `missing_chamber_model_config` rows (nothing parked fail-closed during the pause window) — **agreement cascade UNPAUSED**. Pipeline hardening (Anthropic `max_tokens` retry-then-salvage, invalid-PDF pre-validation via pdf-lib, 120s AbortSignal timeouts on sync provider fetches, LlamaParse post-SUCCESS result-404 retry, estimated-USD telemetry pricing for OpenAI/Anthropic/Gemini/Mistral) lands via PR #453 (cherry-pick of `bda730a`; gates re-run on current main: typecheck clean + 130 files / 1,345 tests). Deploy of main HEAD (ships #452 + #453) follows announce-then-deploy; receipt in #agent-sync. Owner P0 still outstanding: rotate the Quiver API token printed verbatim in the #409 row below (flagged in #agent-sync; needs owner action).
- 2026-07-15 — CODEX — In Progress — OpenAI GPT-5.6 PDF detail repair after one-doc benchmark found `detail=original` rejected by Responses API; branch/worktree codex/openai-pdf-detail-high /Users/jay/.codex/worktrees/congress-openai-pdf-detail-high; files app/src/extraction/bakeoff.ts, app/src/extraction/batchExtract.ts, focused tests and full suite green, PR/deploy pending.
  Deployed via PR #438 (`d9f1a30`); production Worker `f8861f6f-65f3-49fc-bb3e-34890a01db84` deployed via `app/scripts/ship.sh`; apex/workers.dev health green. Retest saved OpenAI runs: House `40a3a9c6-f6c3-4e34-9e77-715cbf70d3eb`, Senate `7fc8ed34-ba38-42d5-8325-135ab6c7be80`, Executive `1e56bdee-aa83-4a3b-9c37-ff1ec50ae852`.
- **Benchmark reuse/manual A-B-C/clear-history + final usage-telemetry D1 fallback (CODEX root, owner-directed 2026-07-15) — MERGED / PRODUCTION DEPLOYED / LIVE GREEN.** PR #411 merged as `7a6679f311876e825dd8932cb3ab795ae9fa2ea8`; production Worker version `37c47653-6ca9-4a0f-baa8-32b962df7e5d` deployed through canonical `app/scripts/ship.sh`, Sentry sourcemaps uploaded for release `7a6679f`, and `/api/admin/migrate` applied `0042_usage_telemetry_fallback_events` through the Worker binding. Apex and workers.dev health report `ok/db/schema=true`, `missing=[]`. Benchmark history supports chamber-scoped clear-history, manual A/B/C save without requiring a completed run, source-run-backed save with audit metadata, and successful-result reuse so already-successful model/doc cells are not rerun for paid calls. The prior final telemetry gap is closed with Queue -> R2 -> direct Usage Monitor delivery -> D1 retry outbox/drain. Verification: local focused telemetry/benchmark/schema/UI/admin routes passed 161/161, full app suite passed 127 files / 1,265 tests, typecheck and diff-check passed; PR hosted CI/PWA/gitleaks passed; isolated preview `a0919c4a-48bf-4204-9ecf-26bdb12103bf` was healthy before production. No paid benchmark/provider call, production benchmark rerun, or Infisical settings write was invoked.
- **Quiver Quant API Key and Latency Watcher Slicing Fix (AG, S) — DEPLOYED / LIVE VERIFIED 2026-07-15 via PR #409.** Extracted and configured the Quiver API token (`***REMOVED***`) in Wrangler secrets. Sliced raw JSON arrays from Quiver's House and Senate live endpoints (5,000 rows each) to `max` (default 100) before parsing to prevent D1 database sequential insert timeouts (Cloudflare Worker execution/subrequest timeouts). Verified clean typechecks, all 1192 unit tests, preview triggers, and triggered a live production latency probe fetching 400 rows and matching candidate consensus successfully in under 2 seconds.
- **Dashboard title-only stale-PR carry-forward (CODEX + verifier, S) — DEPLOYED / LIVE VERIFIED 2026-07-13 via PR #390 (`5da2f9c`).** Production and historical mock titles are now `Congress.Trade` and `Congress.Trade (Design Mock)`; all unrelated stale-PR UI edits were excluded. Focused 69/69, typecheck, lint, independent review, preview 122 files / 1,129 tests, hosted Worker/PWA/gitleaks, and protected production deploy run `29305137481` passed. Worker version `28251fd5-dd7d-45ea-bfe2-14a912abe989`; apex and workers.dev health report `ok/db/schema=true`, `missing=[]`; live browser title is `Congress.Trade`. Superseded conflicted PR #375 is closed with a production receipt.
- **Benchmark daily-cap UTC-boundary hotfix (CODEX + verifier, S) — DEPLOYED / LIVE VERIFIED 2026-07-13 via PR #388 (`843c0f8`).** Production workflow `29304326618` passed install, typecheck, 122 test files / 1,128 tests (1,109 pass + 19 environment skips), canonical `ship.sh`, `POST /api/admin/migrate`, and readiness. Worker version `70d98397-e303-4eb3-9a4e-a0d0b7d9153d`; apex and workers.dev health report `ok/db/schema=true`, `missing=[]`; live DOM contains the benchmark UI and explicit new-day reservation disclosure. Authorization is bound to its exact UTC reservation day; supplemental reservations occur only after a unique cell claim; token-fenced release preserves unknown-outcome state; legacy profiles fail closed; concurrent/day-keyed/UI regressions and adversarial review pass. No paid benchmark or lineup save ran.
- **Manual Enrichment of Missing Tickers (AG, S) — DEPLOYED 2026-07-12.** Extracted 199 tickers missing sector and enrichment data from production D1 `securities_ref` (legacy stocks, options, funds). Wrote a local Node/Python classification script mapping these to appropriate asset classes and generating a SQL update script. Remotely executed the update via `wrangler d1 execute DB --remote`, successfully categorizing all 199 edge cases. Row count for missing sectors validated at exactly 0.
- **Review Queue current drain + durable automation integration (CODEX, L) — DEPLOYED
  2026-07-11 via PR #292 (`f197e66`).** Exact-tree preview Worker
  `e1c8fb70-4291-4872-b1e2-f45f59367e6f` passed health/schema checks before the
  canonical production ship deployed review-release Worker
  `69b4c3cf-8543-459f-a541-623dc7cd692c` and applied `0025` plus `0029`-`0037`
  through `POST /api/admin/migrate`. Time Travel bookmark:
  `000001af-0000d458-000050a5-6a11a98a065b736d72328812598fbac8`.
  PR #262 subsequently advanced `main` to `bb92250` and production to Worker
  `79945ec6-3434-472a-8d7e-76b2df1ffa04`; `f197e66` is its direct ancestor and
  live `GET /api/health` remains HTTP 200 with `ok/db/schema=true`, `missing=[]`.
  Autonomous replay/cascade reduced the queue from 27 to 20 pending by publishing
  7 House filings / 13 rows at tier 3; every receipt records three distinct models
  and every row was present in all three reads. All 13 live rows have non-null
  `est_value`, durable generic-outbox intents, and completed delivery. The remaining
  20 safely reached the three-attempt cap with 0 claims, stale leases, backoffs,
  suppressions, or scheduled work; budget stopped at 169/300. Release-window model
  results: Mistral 71/71 successful, OpenAI 70/70, Anthropic 11/27; the 16 failures
  split into 8 invalid Senate PDF objects and 8 truncated/malformed JSON responses.
  No manual agreement write was needed. Follow-up: make Anthropic handling
  chamber/content-aware and add bounded JSON repair/output-size handling before
  retrying those 20. Operational watch: Infisical intentionally overrides
  Wrangler vars, so keep its agreement enable flag current and do not disable env
  fallback until all agreement keys exist; diagnostics currently show cache ready,
  both secret sources healthy, and 0 resolver errors. Gates: typecheck, 104 files /
  908 tests, lint 0 errors, hosted typecheck/test + PWA + gitleaks green, and two
  quiet post-retry samples. Closeout
  PR #294 merged as `b25a258`; its automatic docs-only main deployment produced
  current Worker `99b20f54-3d25-4b3a-b241-eb1c7aaa9e43`, whose script etag is
  byte-identical to the preceding dependency-bump Worker `97d5e26e`. PR #256
  changed package metadata only and passed all hosted gates; agreement code is
  unchanged from PR #262. Post-churn health remains green.
- **Whole-app improvement roadmap implementation (CODEX, XL) — IMPLEMENTATION COMPLETE LOCALLY +
  PREVIEWED 2026-07-11; PRODUCTION WORKER DEPLOYED 2026-07-11.** PR #284 merged as
  `8a855cb`; canonical `app/scripts/ship.sh` deployed code-bearing Worker version
  `d1dcd17f-8724-40db-9980-6d4f7f6f88e3`, applied the idempotent schema through the Worker D1
  binding, and verified `https://congress.trade/api/health` with `ok/db/schema=true`. Production
  liveness, public UI, client bootstrap, security headers, authenticated diagnostics, both active
  DLQ consumers, and Infisical app/shared reads were verified. Main CI/security/pin/PWA checks are
  green. Closeout PRs #290/#291 merged, and their final docs-only `main` push produced no-code Worker
  version `27554acd-9aab-4995-b844-7d80d937b912` while preserving the same app bundle and healthy
  readiness; use Cloudflare's deployment list for the current version ID after later pushes.
  No ingestion, queue drain, backfill, or billing activation ran; live billing capability
  remains explicitly unconfigured. PWA and iOS source is merged to `main`, but those prototypes have
  no configured production host/App Store target and are not falsely claimed as separately released.
- **Codex autofix: migrate CI loop from Anthropic to DeepSeek (MONET, S)** — DEPLOYED
  2026-07-10, owner-approved ("merge deploy"). Merged
  [#258](https://github.com/jaywedgeworth22/Congress.Trade/pull/258) (`a9bc198`) + docs
  follow-up [#260](https://github.com/jaywedgeworth22/Congress.Trade/pull/260) — caller passes
  `DEEPSEEK_API_KEY` through instead of the deleted `ANTHROPIC_API_KEY`. Companion
  [congress-trading-shared#140](https://github.com/jaywedgeworth22/congress-trading-shared/pull/140)
  merged first (required — caller references the reusable workflow via `@main`); renames the
  `workflow_call` secret and routes `claude-code-action` to DeepSeek's Anthropic-compatible
  endpoint. Codex review on #140 caught that the action's buffered-inline-comment classifier
  hardcodes `https://api.anthropic.com` and would 401 + post every buffered comment unfiltered
  under a DeepSeek key — fixed with `classify_inline_comments: "false"` (verified against the
  action's actual source). Ran `deploy.yml` via `workflow_dispatch` (run 29130234879): typecheck
  + test passed, Cloudflare Workers deploy succeeded, `GET /api/health` → `{"ok":true,"db":true}`
  verified with a browser UA. Not yet done: dispatch `codex-autofix.yml` itself against a real PR
  to confirm the DeepSeek-routed action runs end to end; swap `deepseek-v4-flash` →
  `deepseek-chat` if "model not found".
- (record production Worker releases here after explicit owner-approved deploys)
- 2026-07-05 (CLAUDE next-wave) correction: this section read as empty/no-deploys, but production
  actually received Worker uploads on **6/30, 7/2, and 7/3** via Deploy runs that then **FAILED the
  health gate** (health check 403'd on a Cloudflare managed challenge from the GH runner IP, so the
  `POST /api/admin/migrate` step never ran in any of the three). Production is currently running
  Worker version `eafb0a16` (deployed 7/3) in this unverified state — code shipped, but whether the
  D1 schema is in sync with that code is **unconfirmed**. See new Planned rows below (Cloudflare
  health-gate bypass; schema-drift audit) for the fix and follow-up.

## Completed
- **Follow-ups batch: brand archive + Zilla wordmark + exec filer enrichment + workerd diagnostics
  + ship.sh parse smoke; shared v1.8.0 executive chamber (CLAUDE, M) — 2026-07-15,
  owner-directed, built via five parallel isolated subagents.** PR #446:
  (a) `docs/brand/` archives the logo/wordmark/domain exploration (decision record + both
  interactive design sheets); (b) Zilla Slab 700 latin subset (26.1KB woff2, OFL 1.1, via
  @fontsource devDep) embedded as a data-URI @font-face in `dashboardHtml.ts` — the wordmark is
  now deterministic on every device, +~35KB HTML; (c) all six EXECUTIVE_FILERS get party +
  Wikimedia official portraits (each URL verified HTTP 200), threaded through an
  ON CONFLICT DO UPDATE COALESCE upsert in `watcher.ts` so the existing prod EXEC-DJT/EXEC-JDV
  rows refresh on the next OGE poll (House/Senate filer writes untouched); (d) new dispatchable
  `runner-workerd-diagnostics.yml` (8 non-fatal probes: ldd, strace, miniflare smoke) to
  root-cause the self-hosted runner's workerd EPIPE; (e) `ship.sh` now parse-checks every inline
  script of the served dashboard post-deploy (node --check; proven against live prod = 3 scripts
  OK, and against a crafted broken page = exit 1) — the 2026-07-12 outage class is now caught at
  deploy time. SHARED PACKAGE: branch `claude/chamber-executive` adds "executive" to
  ChamberSchema (z.enum single source of truth; all chamber-typed fields inherit), tests 393
  green, v1.8.0 + CHANGELOG; app pin bump + dropping the app-local Chamber widening ships as the
  follow-on PR after the shared merge. Gates: typecheck + 128 files / 1287 tests green. House 6260461d-3810-4bc5-bd7f-331a8d2adbb1; Senate fe05ad8f-c8b6-44f2-9acb-775d4259df00; Exec ab2c7d43-ce88-4546-975b-2340671e5bc3. Findings: Gemini credits depleted; OpenAI detail=original bug; Senate selected raw object invalid PDF; Exec large-doc JSON/timeout issues.
- **Remove agreement model globals / require explicit chamber lineups (CODEX, S) — MERGED PR #433 + docs closeout PR #435 / PRODUCTION DEPLOYED 2026-07-15.** Global agreement model values were removed from runtime/config/docs; House, Senate, and Executive A/B/C selections are explicit Infisical keys and incomplete lineups fail closed into human review. Production Worker `5738252f-baf6-4fc5-ac5d-80b7fc79cc72` is healthy; live config-sources shows no globals and all nine chamber keys from Infisical.
- **Audit and land all verified local-only improvements; evaluate Batch savings and primary reader (CODEX + audit team, L) — COMPLETED / MERGED PR #414 / PRODUCTION DEPLOYED 2026-07-15 / KEEP OUT.** Owner-requested fleet audit and consolidation landed as `d0d4d67493d779c2dbb43c986311d1dc1631f55a` from `origin/main@7a6679f`; preview `f153d5f5-28de-4702-ae3b-208a946cb456` passed; production Worker `62af245e-7f18-4048-88c4-d819831abdef` is healthy with schema ready. House/Senate/Executive lineups are valid; House A is `mistral:mistral-ocr-latest`; OpenAI Terra/Luna/Sol catalog access is available; no paid model call ran. No uncommitted/secret-bearing files from dirty worktrees were staged.
- **Remove GPT-4o from scanned-disclosure extraction (CODEX + verifier, S) — COMPLETED / MERGED IN PR #414 / PRODUCTION VERIFIED 2026-07-15.** GPT-4o is blocked from new disclosure reads; stale agreement config upgrades to Terra; Terra/Luna/Sol use Responses reasoning tiers and original-detail inputs; historical GPT-4o results remain readable. All 127 files / 1,280 tests pass. Production Worker `62af245e-7f18-4048-88c4-d819831abdef` is healthy; UI has no active GPT-4o choice; House/Senate/Executive settings are valid with House A `mistral:mistral-ocr-latest`. No paid/provider inference ran.
- **Dashboard Interactivity & Visual Toggles (AG, S) — COMPLETED 2026-07-13.** Added interactive SVG building icons and H/S/E badge toggles for the branch selection filter, and animal emojis (🫏, 🐘, 🦅) for the party filter to replace the old native dropdown boxes. Reorganized logic to make these filter toggles mutually exclusive where appropriate and globally linked in the dashboard.
- **iOS improvement roadmap audit (CODEX, M) — COMPLETED 2026-07-12; READ-ONLY.** Audited fetched
  `origin/main` at `5aca5f6` across SwiftUI architecture/UX/accessibility, backend client contracts,
  tests, performance, privacy, signing, CI, and App Store readiness. Generic Simulator Debug,
  build-for-testing, and unsigned generic-device Release builds pass on Xcode 27 beta; no Simulator
  runtime is installed, so XCTest/UI/runtime profiling did not run. P0 plan starts with gap-free ASC
  feed paging, failed-command replay handling, partial watchlist patches, and native auth/account
  lifecycle before further polish; then modular state/data architecture, accessibility/discovery,
  device profiling, stable-Xcode CI, signing/privacy, and TestFlight. No app code, deploy, migration,
  ingestion, queue, or production state changed.
- **Web UI unification with iOS aesthetics (AG, M) — COMPLETED 2026-07-12.** Updated the Next.js PWA and the Admin Dashboard with frosted glass panels (`backdrop-filter: blur(20px)`), vivid gradient asset markers, and bold status pills to mirror the newly designed iOS SwiftUI prototype. Verified typechecks and PWA builds.
- **Interactive dashboard metrics and table sort controls (AG, S) — COMPLETED 2026-07-11 via PR #303.** Added sparkline charts to the dashboard's snapshot metrics (Net Flow, Buy Pressure) and interactive `<thead>` sorting controls with Asset Type filters to the "What Congress Is Trading" and "Rising Activity" panels in `dashboardHtml.ts`.
- **PR review-comment follow-ups across #312/#315/#337/#338/#339 (CLAUDE, M) — 2026-07-12.**
  Owner-directed. Fixed the still-valid unresolved chatgpt-codex-connector P2 threads on merged
  PRs: benchmark ground-truth-docs SQL (filings has no `source` column — now joins live manual
  transactions rows); OGE `last_poll:oge` checkpoint moved after persistence (matches
  House/Senate ordering); executive filings excluded from disclosure-latency candidates (were
  permanently-pending skew); `priceRangeQuery` no-window cap now returns the LATEST 1000 rows
  re-sorted ascending (was oldest-first truncation); PATCH /subscriptions premium gate anchored
  to the subscription owner via `user:`-prefixed clientId (was any-session cookie + dead
  `getUserById('user:<id>')` fallback that skipped the gate on secret-only requests); 13
  single-backslash regexes in the DASHBOARD_HTML template double-escaped (emitted JS had
  `/s+/g` etc. — cleanAsset was deleting letter runs, `looksLikeRawTransactionLine` never
  matched); `#tableTrTickers` header realigned from 8 to 6 columns matching `loadTrTickers()`
  cells with the Est. Volume header hidden by the existing phone rule. Also restored the two
  EFFORT-LOG records below deleted by PR #319 (per its unresolved thread). The stale `apiCall`
  thread on #312 was verified already-fixed by #338. Threads replied/resolved with fix refs.
- **Ingestion fetch outage: R2 known-length regression fix + dead-letter recovery (CLAUDE, M) —
  2026-07-12.** Every filing fetch in production failed from 2026-07-11T19:14Z onward with
  `fetcher: Provided readable stream must have a known length` — PR #284's `limitedFilingBody`
  size-guard wraps the response in a NEW JS ReadableStream, which R2 `put()` rejects (no known
  length; upstream Content-Length doesn't carry over, and OGE's Domino server sends chunked with
  no Content-Length at all). Casualties: all 500 filings of a just-started H-2015 house backfill
  (ingestion_outbox rows dead-lettered to `failed` after the 5-cycle cap) + all 17 executive OGE
  278-Ts discovered by the first post-#315 watcher poll (still cycling, self-recover on fix).
  The fetcher unit tests mocked `RAW_FILES.put` as stream-draining, so CI could not catch it.
  Fix: `bufferFilingBody()` buffers through the existing byte-count guard (25MB cap intact) and
  hands R2 a known-length `Uint8Array`; regression test pins a no-Content-Length chunked response
  (put receives buffered bytes, never a bare stream). Recovery: new
  `POST /api/admin/ingest-requeue-failed` (`requeueFailedIngestionOutbox`: failed→pending with
  fresh dead-letter budget, optional docIdPrefix, dryRun) + the per-minute outbox flush drains the
  backlog. Gates: typecheck + 111 files / 977 tests green. Playbook: merge → `deploy.yml` →
  requeue failed rows → verify fetches resume (receipts in #agent-sync closeout).
- **Executive-branch (Trump) trade tracking — OGE Form 278-T ingestion (CLAUDE, L) — BUILT
  2026-07-12 (claim posted to #agent-sync before work).** Owner-approved. New
  `src/ingestion/ogeSource.ts` polls the OGE President/VP index (~6h, fail-soft; parser verified
  against the LIVE index: all 17 Trump 278-Ts, Aug 2025–Jun 2026) and feeds the normal pipeline as
  `chamber='executive'` (scanned PDFs → vision extractor → review queue; filings >
  OGE_MAX_VISION_BYTES route straight to review — page-chunked extraction is the follow-up for the
  113-page equity mega-filings). Chamber union widened APP-LOCALLY
  (`SharedChamber | 'executive'`, upstreaming to congress-trading-shared v1.7 is the socialized
  follow-up); SEPARATE-BY-DEFAULT everywhere: feed/analytics default to house+senate (executive
  requires explicit `chamber=` CSV opt-in), subscriptions without an explicit chambers filter never
  receive executive rows, and App-B PIT exports exclude them. UI: House/Senate/Executive chip
  multi-select replaces both chamber dropdowns (persisted, ≥1 chip always on). Admin
  `POST /api/admin/oge-backfill`. Knobs OGE_* (Infisical-tunable, in config-sources registry).
  NOTE for AG: brushes `client/utils.ts`/`client/routes.test.ts` again (chamber parsing).
- **Production outage diagnosis + PR #300/#308 landing — DEPLOYED 2026-07-12 (CLAUDE, M).**
  Receipt: `deploy.yml` run 29177444399 succeeded on `b8ce1b4`; live verification passed (all
  served script blocks parse; health ok/db/schema true; scoreboard + Alerts tab live with real
  probe data; scrape guard 403s bare curl on data APIs). Original entry follows.
- **Production outage diagnosis + PR #300 landing + deploy-gate fix (CLAUDE, M) — 2026-07-12.**
  Owner reported the live site loading no data. Diagnosis: the deployed Worker served a dashboard
  whose main inline script FAILED TO PARSE ("Unexpected end of input") — the build came from an
  UNPUSHED working tree containing an in-progress "Extraction Benchmark" dashboard feature
  (`runBenchmark`, model lineups; exists in NO git branch — AG-style bake-off work) with collapsed
  template-literal escapes (`\\s`→`\s` etc. in `app/src/ui/dashboardHtml.ts`) and a splice that
  clobbered `loadMarketCoverage`'s closing braces. APIs/data were healthy throughout; only the UI
  died. That tree could never pass `npm test` (the suite pins script parseability) — it was shipped
  without the test gate. Fix per owner: PR #300 merged to `main` (`2ed8517`) and `deploy.yml`
  dispatched. Deploy attempts 1-2 failed on the SELF-HOSTED runner only: `reviewResolutionD1.test.ts`
  dies with miniflare/workerd `write EPIPE` (deterministic on that container; passes on hosted CI +
  dev containers). Follow-up commit makes that suite probe workerd and skip loudly where it cannot
  start, plus CLAUDE.md defaults (agent-sync coordination + effort-log updates by default, per
  owner). NOTE for AG: the redeploy OVERWRITES the unpushed benchmark experiment in production —
  commit it to a branch if wanted (and mind the doubled-backslash rule in dashboardHtml.ts).
  Also flagged: deploy runner cannot spawn workerd — worth a look at the Hetzner container.
- **Infisical single-source-of-truth config consolidation (CLAUDE, M) — COMPLETED 2026-07-11 on
  `claude/antigravity-latency-security-x6lkvb` (second commit on PR #300, not deployed).** Audit
  found ~90% of keys/knobs already resolver-backed; converted the rest (FMP/EDGAR pacers, latency
  probe knobs, seed URLs, house live-search flag, admin-open flags, arbitration enable + vision/
  arbitration model choices now resolved per-extraction). New admin audit endpoint
  `GET /api/admin/config-sources` (per-key live source, names only) + `app/docs/config-registry.md`;
  wrangler [vars] re-documented as fallback defaults; `.dev.vars.example` now recommends
  Infisical-bootstrap-only local setup. Env fallbacks kept deliberately (outage resilience;
  `INFISICAL_ALLOW_ENV_FALLBACK=false` for hard-require). Sentry init trio + INFISICAL_* bootstrap
  are the documented env-only exceptions. Gates: typecheck; 109 files / 959 tests. Rollout note:
  `docs/rollouts/2026-07-11-infisical-single-source.md`.
- **Public latency showcase + public delivery education + anti-scrape hardening (CLAUDE, L) —
  COMPLETED 2026-07-11 on `claude/antigravity-latency-security-x6lkvb` (not deployed).** Owner
  request from the Antigravity disclosure-latency findings: (1) new public
  `GET /api/analytics/latency-summary` (aggregate `publicSummary` only, KV-cached 5 min) plus a
  "Speed vs. Data Providers" race-lane scoreboard on the Trends landing view, designed via a
  three-expert UI panel with honesty guard rails (full lane ≥5 matches, boast copy ≥10 matches AND
  positive median, neutral 0-match empty states, losses/sample sizes always shown); (2) the
  admin-only Developer Delivery tab is now a public "Alerts" tab teaching the two paid delivery
  methods (signed webhooks, SSE) to signed-out visitors, with management still admin-only and the
  pricing modal reworked around delivery-first features + a guard-railed live proof line;
  (3) `src/security/botDefense.ts` anti-scrape guard on `/api/*` (scraper/AI-crawler UA blocklist,
  300 req/5 min per IP, shared 20k rows/day per-IP budget on `/api/transactions` +
  `/api/client/v1/feed`, 10k offset cap, `X-Robots-Tag: noindex`; token-gated surfaces exempt;
  fails open; `SCRAPE_GUARD_ENABLED` kill switch, Infisical-overridable). Site remains fully public
  for humans. Gates: typecheck; 108 files / 957 tests. Rollout note:
  `docs/rollouts/2026-07-11-latency-showcase-and-bot-hardening.md`. NOTE for AG: touches ~14 lines
  in `app/src/client/routes.ts` (`/feed` row budget) — coordinate with the in-progress client
  routes refactor before landing both.
- **Push account status metrics to Usage Monitor (AG) — COMPLETED 2026-07-11.** Updated `jobs.ts` to emit a separate `metricType: 'limit'` telemetry event to the Usage Monitor for the FMP daily call cap, alongside the existing usage tracking.
- **Whole-app evaluation and improvement audit (CODEX, read-only) — COMPLETED 2026-07-11
  (assessment only; no merge applicable).** Audited `origin/main` at `8b34bd5`, live desktop/mobile
  UI, safe production GETs, backend/data/delivery/security/ops, PWA, SwiftUI, tests, dependencies,
  CI, open PRs, and deployment/migration paths. No app-code, deploy, migration, ingestion, queue, or
  production mutations. Report prioritizes delivery outbox/SSE/fetch retries, truthful health and
  migration readiness, billing correctness/configuration, and client data-loss/release gaps.
- **Fix ship.sh admin migrate 403s on workers.dev fallback (AG, S) — COMPLETED 2026-07-10.** Added `ADMIN_BASE` to `ship.sh` so `POST /api/admin/migrate` properly uses the `workers.dev` bypass when the primary health check fails due to Cloudflare managed challenges.
- **Fix uptime-monitor.yml heredoc EOF crash (AG, S) — COMPLETED 2026-07-10; FOLLOW-UP REQUIRED 2026-07-11.** Swapped static `EOF` delimiter for a dynamic `$(openssl rand -hex 8)` delimiter so a response body containing `EOF` cannot close the output early. Scheduled run `29164917660` exposed a separate framing defect: compact JSON without a trailing newline concatenates the dynamic terminator to the body, so GitHub still reports `Matching delimiter not found`. The distinct newline fix is reserved below.
- **Preserve login subdomain origin on redirect (AG) — COMPLETED 2026-07-10 via PR #253.** Implemented origin tracking via a short-lived `ct_auth_origin` cookie for Google OAuth and `origin` query parameter for Magic Links, returning users back to the starting subdomain (e.g. `admin.congress.trade`) instead of default apex domain. Added unit tests for redirect origin validation.
- **Fix subdomain session cookie sharing and state issues (AG) — COMPLETED 2026-07-10 via PR #251.** Added a dynamic `getCookieDomain` helper to share `ct_session` and `OAUTH_STATE_COOKIE` across subdomains. Updated `/auth/me` to support Cloudflare Access JWT assertions, allowing admins on subdomains to immediately see the admin panels even without an active first-party user session. All 671 tests passed.
- **Wave-4 go-live smoke script (AG, S) — COMPLETED 2026-07-06 via PR #214.** Small script that probes `GET /auth/me`, `GET /billing/status` (expect `configured:true`), Google OAuth start redirect, magic-link send, and a Stripe test-mode checkout round-trip, printing a go/no-go checklist. Fixes the arithmetic exit issue and adds missing probe endpoints.
- **Close unresolvable Dependabot PRs + cross-subdomain cookie fix (AG, S) — COMPLETED 2026-07-08.** Closed PR #247 (TypeScript 7.0.2) and PR #238 (Cloudflare group bump) — both blocked by upstream peer dependency conflicts that no alpha/beta/canary release has resolved. Added `domain: .congress.trade` to `ct_session`, `ct_oauth_state`, and clear-cookie calls so sessions work across `congress.trade` ↔ `admin.congress.trade`. Added richer error logging to Google OAuth callback (token-exchange vs profile-fetch vs unknown). All 670 tests pass, typecheck clean. Branch `copilot-antigravity-resolve-prs`.
- **Reconcile live-search overlay rows against the official House index (data-quality job) (AG, M) — COMPLETED 2026-07-06.** PR #194 opened. Nightly/admin job that re-checks recent `pollHouseLiveSearch()`-sourced transactions against the next-day official House disclosure index, flagging missed, mutated, or orphaned filings into the existing DLQ/diagnostics surface.
- **Deduplicate Types (AG, M) — COMPLETED 2026-07-05.** PR #185 opened. Used `congress-trading-shared` and dropped local duplicated schemas (Chamber, Owner, TxType, AssetTypeCategory, ClientTrade). Updated `client/routes.ts` tests to align with the shared `ClientTrade` shape.
- **Shared-dep tokenless git-dependency switch (CLAUDE, cross-app).** Both halves merged
  2026-07-04 (Congress.Trade #139 + Socratic.Trade #439); see TRADING board row for the
  Socratic.Trade half. 2026-07-05 (CLAUDE next-wave): moved here from In Progress — both PRs
  are merged and this row was stale; the GitHub Issues mirror (#145) still shows
  state:in-progress and should self-close on the next Effort Issues Sync run.
- **PR #162 - Effort-issues sync secondary-rate-limit hardening (CLAUDE).** Merged to `main`
  2026-07-05. Verbatim propagation of the fleet-standard `scripts/sync-effort-issues.py`
  hardening from Socratic.Trade PR #694 (creation throttle, Retry-After/backoff retries under
  a bounded budget, exit-0 partial-sync summary), including the three refinements from the
  Codex review on this PR (issue listing inside partial handling, server Retry-After honored
  uncapped, 1s update throttle).
- (seeded empty — see repo git history for pre-protocol work)
- **PR #139 (`claude/tokenless-shared-dep`, Claude) — MERGED 2026-07-04 (`cf6221e`).**
  Cross-repo effort (see `/Users/jay/apps/TRADING-EFFORT-LOG.md` for the Socratic.Trade half,
  jaywedgeworth22/Socratic.Trade#439). `congress-trading-shared` is now public; switched off
  the private GitHub Packages registry (`NODE_AUTH_TOKEN`/`GH_PACKAGES_TOKEN` auth) onto a
  tokenless git dependency: `app/package.json` ->
  `github:jaywedgeworth22/congress-trading-shared#semver:^1.2.x`, dropped `app/.npmrc`,
  removed the "Configure GitHub Packages" step + `packages: read` permission from
  `ci.yml`/`deploy.yml`/`deploy-staging.yml`, updated `shared-package-pin-check.yml`'s `norm()`
  to compare git-dep refs (extract after `#`) instead of only bare semver (`GH_PACKAGES_TOKEN`
  stays there for its unrelated purpose: reading the still-private Socratic.Trade peer repo's
  `package.json` via the GitHub API). Found this session's own prior work already sitting
  uncommitted in a scratch worktree (died mid-task, never pushed) — reviewed it, reproduced its
  tokenless-install proof independently (clean `npm ci` with `NODE_AUTH_TOKEN`/`GITHUB_TOKEN`/
  `GH_TOKEN` unset AND `GIT_SSH_COMMAND=/bin/false`), reran the gate (typecheck clean, 77 files /
  669 tests pass), landed as-is. STATUS.md carries the full paper trail (no
  `docs/EFFORT-LOG.md`/rollout-notes convention in this repo's `AGENTS.md` today ***[2026-07-05
  (CLAUDE next-wave): outdated — AGENTS.md now mandates the docs/EFFORT-LOG.md mirror and the
  file exists at origin/main, added via #137/#141; only the rollout-notes half of the original
  claim is still true]***). Post-merge
  note: `Shared package pin check` briefly showed FAILURE on `main` right after this merged —
  transient, since Socratic.Trade's own pin hadn't switched yet at that instant; not a required
  check and self-corrected once Socratic.Trade#439 merged.
- **CURSOR-assigned backlog tasks (CURSOR, `cursor/assigned-tasks-v2`) — MERGED 2026-07-08 via PR #211 (`ef732f3`).**
  Six tasks across 3 subagents, all gates green (typecheck clean, lint 0 errors,
  672 tests pass). Rescued from stash@{1} into PR #211 (`cursor/assigned-tasks-v2`).
  Dropped hunks already merged via #139/#140 (CI cleanup, .npmrc, dep downgrades).
  Genuine work preserved: noUnusedLocals/noUnusedParameters true, tsconfig.ingestcheck
  deleted, ESLint deps + lint/coverage scripts, lockfile-based pin-check, AGENTS.md
  dedup, unused-code removal across 8 files, dashboard CSS cleanup.
- **Wire the live/intraday House search path (CODEX, M).** COMPLETED 2026-07-05 via
  PR #160 (`codex/house-live-search` -> `main`, merge `3e2d622c`). Previously
  in progress 2026-07-04 on
  branch `codex/house-live-search` in worktree
  `/Users/jay/.codex/worktrees/congress-house-live-search`; validation found the
  implementation already exists, so this lane adds direct `pollHouseLiveSearch()`
  coverage and watcher-behavior coverage while removing stale stub/TODO docs.
  2026-07-05 (Codex): focused ingestion tests pass, `npm run typecheck` passes,
  and full `npm test` passes (77 files / 673 tests). PR CI green (`typecheck +
  test`, `gitleaks`). Preview deployed and health-checked at
  `https://congress-trade-preview.jaywedgeworth22.workers.dev` (`ok=true`,
  `db=true`); production deploy still requires explicit owner approval.
- **Codex autofix storm guard (CODEX, workflow/fleet-infra) — COMPLETED 2026-07-08 via
  PR #242 (`codex/congress-autofix-storm-guard` -> `main`, merge `1788fa04`).**
  Removed `pull_request_review_comment` and `issue_comment` triggers from
  `codex-autofix.yml`, preserving `pull_request_review` submitted-review handling
  plus manual `workflow_dispatch`, and tightened concurrency to PR/manual input.
  Verified locally with `npm run typecheck` plus full `npm test` (76 files / 670
  tests); PR CI `typecheck + test` and `gitleaks` passed. Workflow-only change:
  no preview or production deploy.

- **Current-main iOS improvement roadmap (CODEX + expert reviewer, S) — COMPLETED / MERGED 2026-07-13 via PR #383 (`83cc5094`).** The code-backed roadmap covers truthful Executive filtering, lossless forward/older sync and tombstones, recoverable command retries, production auth, App Review commerce/privacy, push alerts, scoped state, trace-backed performance budgets, accessibility, observability, CI/TestFlight, and AG overlap sequencing. Generic simulator build, build-for-testing, and Release generic-device build passed; hosted CI/PWA/Security passed. Runtime tests/Instruments remain explicitly pending because no iOS Simulator runtime is installed on this Mac. Docs-only; no SwiftUI or production runtime mutation.
- **[MONET] Diagnosed prod webhook-delivery 401 wall + Review Queue triage (troubleshoot-issues-3c86a2 session, 2026-07-17) — COMPLETED / FIXED (Socratic.Trade PR #1704).** Owner-requested triage on repeating `HTTP 401` webhook delivery failures. Root-caused to `congress.trade` signing `X-Signature: sha256=<hex>` while receiver-side (Socratic.Trade) expected bare hex with no prefix. Fix landed in Socratic.Trade (PR #1704; green gates: lint 0/tsc clean/build clean). Review Queue item `H-2026-20035003` verified as expected validator quarantine; no code change required in `congress.trade`.

## In Progress
- 2026-07-17 — MONET — In Progress — **Incorporate the owner-directed full-app review** (docs/reviews/2026-07-17-full-app-review.md, CLAUDE-authored; owner: "incorporate all that Claude found"). DONE so far: **live incident fixed** — dead `gemini:gemini-3.5-flash` (direct key 403, 152 errors/24h in prod diagnostics) was still wired into House trio slot D + Executive slot C, wasting ~half the 300/day agreement budget and making House unanimity impossible (root cause of 569/824 filings stuck in needs_review). Swapped via fenced admin PUT (config-only, $0): House C/D/E = llamaparse:cost-effective / anthropic:claude-haiku-4-5 / openai:gpt-5.6-terra; Exec C/D/E = llamaparse:fast / anthropic:claude-sonnet-5 / openai:gpt-5.6-terra (both valid=true, 3 distinct providers, independent from the mistral A-primary). AG heads-up posted (their OR lane can later re-introduce gemini via openrouter transport). Owner decision (2026-07-17): **HOLD the ~$22 paid backlog drain** — free/autonomous cascade drains on its own now that the dead model is gone; session focus = the review's CODE-fix PRs. IN FLIGHT: read-only workflow completing the review's §5 (8-domain code panel) + reconciling all 38 UX findings vs current main/#513/#514/#522 into a sequenced PR plan; PR-1 builder (textPdf.ts detached-ArrayBuffer / Sentry CONGRESS-TRADE-2, verified still-broken on main). Code PRs to follow: CSP-fonts (F15), future-date quarantine (F4), annualization math (F13), name/sector normalization (F12/F18), template fragments (F16), admin-surface strip (F6), legal pages (F3). KEEPOUT: coordinating dashboardHtml.ts slices with AG (#513).
- **OpenRouter Model Consolidation & Mistral OCR Integration (AG) — IN PROGRESS (PR #521 open, awaiting CI).** Swapped direct model endpoints (OpenAI, Gemini, Anthropic, xAI) for their OpenRouter equivalents across default candidates, keeping native Mistral OCR as fallback. Updated settings validation to check underlying providers so multiple OpenRouter models can coexist in one lineup. Refactored `openRouterVision.ts` to implement a branching strategy for Mistral OCR payload format (`image_url`) vs. other vision models (`file-parser`). Double-escaped client-script single quotes in `dashboardHtml.ts` speed section scorecard to prevent syntax errors. Verified settings and bakeoff tests pass locally.
- **CLAUDE→MONET handoff tail: shared v1.8.0 consumption (MONET, 2026-07-15) — IN PROGRESS → CLOSEOUT.** Per `docs/handoffs/2026-07-15-claude-to-monet.md` ("Follow-on PR — app pin bump"): shared package PR #190 (`congress-trading-shared`, adds `executive` to `ChamberSchema`) merged to main; tagged `v1.8.0` = commit `2b13da00b73561738cb56a0107d38d093c48ba6f`. Branch `monet/shared-v180-pin-bump` bumps the exact-commit pin in both root and `app/package.json` (plus matching `allowScripts` keys, CODEX's by-commit convention) from `0bc26ab9…` to `2b13da00…`, regenerates both lockfiles (installed version confirmed `1.8.0`), and drops the app-local `Chamber` widening in `app/src/shared/types.ts` — `Chamber`/`ClientTrade` are now plain re-exports of the shared types since shared's `member.chamber` is nullable-compatible (`Chamber | null`, matching the old app-local shape exactly). Gate green: `cd app && npm run typecheck && npm test` — 130 files / 1,348 tests. The `Shared package pin check` workflow is EXPECTED red on this PR because Socratic.Trade still pins v1.7.1 (non-blocking, not a required check; a parallel lane is bumping ST concurrently). The unrelated workerd diagnostics workflow Node-22 fix landed separately as PR #456.
- 2026-07-15 — CLAUDE — In Progress — Fix false-positive `Shared package pin check` red on `main` (branch `claude/pin-check-ref-normalize`, single file `.github/workflows/shared-package-pin-check.yml`). Root cause: the check compares raw lockfile `resolved` strings, so CT's `git+ssh://` vs ST's `git+https://` transport reads as divergence even though BOTH repos pin the identical shared commit `0bc26ab9` (v1.7.1). Fix normalizes to the ref after `#` before comparing (registry versions pass through; real ref divergence still fails). Clears Sentry FLEET-INFRA-16/-C/-3C noise.
- 2026-07-15 — CODEX — Completed — prod one-doc all-model benchmark validation + model-stack evaluation on `codex/prod-deploy-latest` / `/Users/jay/.codex/worktrees/congress-prod-deploy-411`. Saved completed runs: House `6260461d-3810-4bc5-bd7f-331a8d2adbb1`, Senate `fe05ad8f-c8b6-44f2-9acb-775d4259df00`, Executive `ab2c7d43-ce88-4546-975b-2340671e5bc3`. Findings: Gemini currently blocked by depleted credits; OpenAI GPT-5.6 Terra/Luna/Sol catalog access passes but live calls fail because app sends Responses PDF detail `original` instead of accepted `high/auto/low`; Anthropic good on House but fails Senate invalid-PDF and Executive JSON parse; Mistral and xAI are the only consistently successful providers across the canary; LlamaParse adapter has result-404/timeouts/markdown parse failures and unknown cost coverage. No code edits in this pass.
- 2026-07-15 — CODEX — Implementation complete locally / PR-deploy pending — `codex/telemetry-cost-audit` / `/Users/jay/.codex/worktrees/congress-telemetry-cost-audit` — restored benchmark lower-bound dollar visibility when only partial call pricing exists (`$x known (partial)` instead of hidden/Unknown), audited LLM/provider telemetry and benchmark cost accounting to API Usage Monitor across Congress.Trade, and recovered saved one-doc House/Senate/Executive benchmark dollar estimates. Files: `app/src/ui/dashboardHtml.ts`, `app/src/ui/__tests__/dashboardHtml.test.ts`. Gates: focused benchmark/UI/telemetry tests 121/121 pass; `npm run typecheck` pass. No AG branch edits, paid provider call, push, PR, or deploy in this lane.
- **Adopt immutable `congress-trading-shared` v1.7.1 in Congress.Trade (CODEX + peer reviewer, S) — MERGED + AUTO-PRODUCTION VERIFIED / CROSS-REPO PIN DRIFT OPEN 2026-07-14.** PR #407 squash-merged as `553412b5`; root/app manifests, lock resolutions, and matching `allowScripts` approvals exact-pin `github:jaywedgeworth22/congress-trading-shared#0bc26ab9311a396f3f6b5cba0fb54fa7558a42b4`. Empty-cache installs, CJS/ESM smokes, artifact hashes, exact-pin assertions, audit 0, typecheck, serialized full Vitest (127 files / 1,259 tests), independent no-P0-P3 review, and isolated preview `ed4189b2-4115-4779-ae4f-7781f3398b7d` are green. PR and post-merge app CI, PWA test/build, and gitleaks passed. The main-branch Cloudflare build automatically deployed production version `0ead417a-b758-4f38-9551-d5b935884aaf` at 100%; its script etag `b082e191...` equals prior version `b12abf38...`, confirming byte-identical runtime. Apex/workers.dev health are HTTP 200 with `ok/db/schema=true`, `missing=[]`; public UI is HTTP 200; unauthenticated benchmark admin access is HTTP 401. No manual GitHub Deploy workflow or manual production deploy ran. Remaining fleet gap: advisory `check-pin` is red because `Socratic.Trade/main` still uses v1.6.0; land the matching Socratic v1.7.1 consumer and rerun both repos' pin checks.
- **Adversarial final review of benchmark reliability repair (CODEX-REVIEW, S) — REVIEW COMPLETE / PASS 2026-07-14; READ-ONLY on `codex/benchmark-failure-repair-20260714`.** No P0/P1 remains after review-driven fixes for full-success lineup eligibility, atomic one-running-run-per-chamber admission, durable model-access diagnostics, provider/model canary admission, cancel-vs-cell-claim fencing, and local-document-failure canary advancement. Independent final gate: 8 focused files / 196 tests, TypeScript, ESLint quiet, and `git diff --check` all pass. Current official OpenAI docs confirm GPT-5.6 Sol/Terra/Luna, the pinned pricing, vision support, and Responses PDF `input_file.detail=high`. Landing verdict PASS, subject to the parent lane's full serialized gate, preview, merge, deploy, migration, and live verification. No implementation edits, paid/provider calls, production mutations, push, merge, or deploy by reviewer.
- **Final Infisical bootstrap line-mapping repair (CODEX verifier/builder, S) — COMPLETED / MERGED 2026-07-14 via PR #402 (`2435e755`).** The dotenv 16.3.1 parser locates the real key after leading whitespace/optional `export`, replaces the actual assignment once, and is byte-idempotent. Imported values round-trip losslessly or fail closed; provider keys stay excluded; live/broken symlinks and unsafe modes are rejected; output is `0600`. The HOME-unset edge skips the optional global file instead of looking under cwd, with a hostile synthetic-secret regression. Clean install found 0 vulnerabilities; typecheck, full Vitest 127 files / 1,258 tests, focused bootstrap 16/16, Node/Bash syntax, tracked/untracked diff checks, hosted app/PWA CI, and gitleaks passed. Independent final review reported LAND with no P0/P1/P2/P3. No real secret reads, remote config writes, provider calls, or production runtime mutation; no Worker deploy was needed because the merged diff is local bootstrap scripts, tests, examples, and docs only.
- **Fresh adversarial landing review of Infisical bootstrap wiring (CODEX-REVIEW, S) — REVIEW COMPLETE / LAND / NO FINDINGS 2026-07-14; READ-ONLY on `codex/infisical-bootstrap-wiring` vs `origin/main` `ae57bcc`.** P0/P1/P2/P3: none after the owner fixed the sole HOME-unset edge: the optional global file is now unavailable when `HOME` is blank, and a hostile cwd fixture proves `.secrets/global-api-keys` is ignored without creating output or printing its synthetic value. Exact Wrangler dotenv 16.3.1 grammar/decoding and key-line mapping, idempotency, complete-pair precedence, allowlisted inert global-file parsing, provider-key exclusion, mode `0600`, live/broken symlink rejection, test-control scrubbing, cloud setup, docs/AGENTS truth, and unrelated-byte preservation pass review. Independent incremental gates: focused 16/16, Bash/Node syntax, tracked/untracked diff and whitespace checks; parent reports typecheck green. No repo edits, real-secret reads, remote writes, provider calls, push, merge, or deploy by reviewer.
- **Production benchmark failure diagnosis and reliability repair (CODEX + expert team, M) — COMPLETED / MERGED / PRODUCTION VERIFIED 2026-07-14.** PR #399 merged as `ae57bcc`; protected deploy run `29364061045` passed install, typecheck, full tests, canonical `ship.sh`, idempotent admin migration, and readiness. Production Worker `e8e92854-c53d-486c-aceb-97cdcc1d1de1`; apex/workers.dev health report `ok/db/schema=true`, and unauthenticated benchmark admin access returns 401. Repair adds durable House/Senate/Executive diagnostics/history, strict-document plus stable-row scoring, measured cost coverage, success/failure latency, resumable/stoppable partial runs, OpenAI catalog readiness, invoked provider/per-model canaries, deterministic non-invoked fan-out, one-running-run-per-chamber admission, status-fenced races, and full-evidence A/B/C promotion gates. Local full 126 files / 1,243 tests plus independent 196-test adversarial review found no P0/P1/P2; preview `2ef3f0ea-750a-425a-bac0-cf26eab2eef4` was green with three chamber fixtures and the unique active-run index. Authenticated D1-only rescore updated all 220 saved terminal cells in interrupted House run `84da721d-aa57-4bec-b34c-ba6898e9fd06` to scoring v2; 66 ground-truth-eligible cells are scored, with zero provider calls. Production currently has that one paused/resumable House run and no Senate/Executive runs yet; no paid rerun, stop, or lineup save was performed.
- **Independent security review of local Infisical bootstrap wiring (CODEX reviewer, S) — REVIEW COMPLETE / LANDING HOLD ON THREE P2s 2026-07-14; READ-ONLY.** `codex/infisical-bootstrap-wiring` correctly maps the real CT + shared aliases to Worker-consumed names, preserves complete-pair precedence, filters provider keys, writes mode `0600`, and passes focused 7/7 plus syntax/diff checks. Hold landing until the owner lane (1) retains a narrow safe pass-through for env-only Sentry and documented local-only overrides, (2) stops validating unrelated valid dotenv syntax, and (3) rejects broken symlink path entries instead of treating them as absent; add regression tests and reconcile canonical `AGENTS.md` guidance. No worktree edits, push, PR, deploy, remote secret writes, or production config mutation by reviewer.
- **Local Infisical bootstrap credential wiring (CODEX, S) — FINAL REVIEW P2S FIXED / FOCUSED 14/14 + TYPECHECK + SYNTAX + DIFF GREEN / READY FOR ROOT LANDING / NOT PUSHED 2026-07-14 on `codex/infisical-bootstrap-wiring`.** The managed-key scanner now copies the exact dotenv 16.3.1 grammar bundled by Wrangler, including whitespace-colon assignments and escaped-quote behavior without backslash-parity drift. Unrelated colon/backslash-sensitive multiline records remain shielded and byte-preserved. Imported values are encoded only after an exact parser round trip; quotes, backslashes, literal escapes, and tabs are lossless, while unrepresentable or multiline inputs fail closed without creating/replacing `.dev.vars`. Docs now state existing non-empty managed values are preservation-first and require deliberate removal/emptying before local rotation; the optional global file requires owner-only permissions, not exact `0600`. Focused 14/14, app typecheck, Node/shell syntax, tracked plus untracked diff checks pass. No secret read, remote secret write, production mutation, provider call, push, PR, merge, or deploy in this final-fix handoff.
- **Usage telemetry stable-key replay hotfix (CODEX + verifier team, M) — COMPLETED / MERGED / PRODUCTION VERIFIED; RECEIVER REFRESH DEGRADED 2026-07-14.** Terminal follow-up PR #394 merged as `a6e83e01` after all hosted checks passed with no review threads. Protected production run `29316698401` passed install, typecheck, full tests, canonical `ship.sh`, admin migrate, and readiness; Worker `47c34b79-9778-4e3d-87ee-200808957079`. Apex and workers.dev health are HTTP 200 with `ok/db/schema=true`, `missing=[]`.
  Sanctioned maintenance run `29307723269` proved stale job `10611cb5-4e6e-4358-b638-4b530ae74c73` is provider-completed while the old app remained running because it required `output_file_id` and ignored `error_file_id`/empty terminal completion. Follow-up branch `codex/openai-batch-terminal-files` treats terminal status as terminal, reads distinct output+error files, strictly parses JSONL, validates exact submitted identities, and reports expected/returned/missing/provider-error counts.
  Accounting mode and aggregate totals are CAS-persisted before measured events; a second CAS pins one resumable terminal winner before outcome-specific side effects; final writes fence on status plus the exact claim. New jobs carry a protocol marker. All unversioned measured per-result units are recorded as `suppressed_unknown` rather than risking a duplicate across unknowable historical key families; legacy rows remain reusable. Deterministic extraction ids and Queue-to-R2 measured telemetry keep retries replay-safe.
  The stateful test DB now preserves real status transitions and exercises valid/invalid winner races, loser blocking, durability retries, cross-file counts/errors, exact stored identities, and legacy suppression. Fresh root gates pass focused 78/78, serialized full 123 files / 1,192 tests, typecheck, lint (0 errors; 109 inherited warnings), workflow YAML, shell parse, and diff check. Two final independent reviews each pass 74/74 plus typecheck/lint/diff and report no P0/P1/P2. Isolated preview version `359b12be-4a00-4923-97c0-b1f85400498a` passes `ok/db/schema=true`, `missing=[]`; unauthenticated batch GET/POST admin routes return 401. Hosted CI/PWA/gitleaks passed, PR #394 merged, and production Worker `47c34b79-9778-4e3d-87ee-200808957079` is healthy. Sanctioned maintenance run `29316914184` settled the historical job `completed` with 2/2 returned provider errors, 0 successful parses, and 86,938 ms lifecycle time; authenticated admin evidence confirms exactly two matching extraction rows, zero successful rows, zero parsed transactions, and zero API failures. Replay run `29316964864` returned `alreadyFinished` and made no provider request. The job is intentionally marked `measuredUsageStatus=suppressed_unknown` because its unversioned historical token key family is unknowable. The live usage dashboard still shows its pre-run cached OpenAI Batch request count of 2 and no token row; Refresh currently reports external telemetry temporarily unavailable, so receiver-side ingestion is being audited and is not misrepresented as confirmed.
- **Persistent chamber benchmark history, measured cost/latency, per-branch A/B/C save controls, and complete third-party telemetry (CODEX + expert team, L) — MERGED / PRODUCTION DEPLOYED / LIVE GREEN; RECEIVER RECEIPT AUDIT PENDING 2026-07-13.** PR #385 merged as `6ec3057a`; protected deploy run `29302121067` passed install, typecheck, full tests, canonical `ship.sh`, `POST /api/admin/migrate`, and readiness. Production Worker version `d8ed11e7-fa4d-4ca4-b03d-0c99f4e87f5d`; apex and workers.dev report `ok/db/schema=true`, `missing=[]`; live browser dashboard renders the House/Senate/Executive saved-run controls with no console warnings/errors. House/Senate/Executive runs and per-document/model results persist with measured latency, provider usage, spend provenance/coverage, prior-run comparison, and sequential cascade simulation; validated A/B/C lineups save through fenced/rollback-safe branch-specific Infisical writes. Paid runs require explicit confirmation, atomic daily caps, human-confirmed ground truth, and unknown-outcome retry confirmation. OpenAI 5.6 Terra/Luna/Sol Responses vision options are included with GPT-4o retained as a legacy control. All Worker and operator-script third-party HTTP calls are statically forced through secret-safe Usage Monitor telemetry with Queue-to-R2 fallback; simultaneous Queue+R2 failure remains the disclosed terminal gap. Local bounded full suite passed 122 files / 1,124 tests, post-rebase focused suite passed 192/192, hosted app/PWA/gitleaks and production full tests passed, fresh migrations through `0040` plus synthetic three-chamber seed passed, and three expert audits found no P0/P1. Preview `f54ea612-04cc-4795-b45b-12b176ce2627` remains healthy with three-chamber history, partial-cost, and latency fixtures. No paid benchmark or production settings save was invoked. PR #382 is functionally superseded; final cross-app receiver receipt audit and open-PR cleanup are in progress before moving this row to Completed.
- **Audit Tier 1 Fixes (surgical unblocks) (AG, L) — IN PROGRESS 2026-07-12.** Fixing webhook signature + shared sign/verify helper; premium entitlement gate + web alerts manager; iOS bearer-token issuance flow; idempotency-replay semantics; PWA since-cursor polling + Retry-After.
- **Beautify iOS SwiftUI Prototype App (AG, L) — IN PROGRESS 2026-07-12.** Refactored monolithic SwiftUI code in `CongressTradeApp.swift` to upgrade styling (glassmorphism, gradient accents, modern card structures). Code compiles correctly locally. Pending PR creation and deployment.
- **Matched `congress-trading-shared` v1.5.0 consumer pin (AG implementation requested by CODEX, cross-app S) — MERGED / DEPLOYED / PRODUCTION VERIFIED; CLOSEOUT READY PR #297 / HOSTED GREEN / NOT MERGED 2026-07-11.** Antigravity exact-pinned `app/package.json` + lockfile to `#v1.5.0`; installed version 1.5.0 resolves commit `2222baeb`. PR #296 merged as `d84fd349` at 18:58:28Z and production Wrangler versions `c5deb474` then `e5c7ebad` deployed at 18:59Z; `https://congress.trade/api/health` is HTTP 200 with `ok/db/schema=true`. This corrects the stale READY/not-merged record and original `^1.5.0` wording. CODEX closeout PR #297 restored STATUS/rollout/mirror receipts and deployed clean merged `main` to isolated preview `4d8a558b`; preview health is green, hosted app/PWA/security checks pass, and production remained on `e5c7ebad`.
- **Fix Uptime Monitor compact-JSON output framing (CODEX, S, ready PR #297) — VERIFIED / HOSTED GREEN / NOT MERGED 2026-07-11.** The health body is newline-terminated before the random GitHub-output delimiter. Scheduled failure `29164917660` is captured in the rollout; a compact-JSON framing harness and YAML parse pass. App lint/typecheck/940 tests and PWA typecheck/13 tests/build pass locally and in hosted CI; gitleaks passes. Workflow-only; no production Worker/D1/config mutation.
- **Backend delivery + ingestion reliability hardening (CODEX/HERSCHEL, L) — INTEGRATED +
  INDEPENDENTLY VERIFIED LOCALLY 2026-07-11.** Transactional ingestion/delivery outboxes, real DLQ
  consumers and bounded recovery, completion-before-ACK, stale-enqueued replay, cross-isolate SSE
  leases/backpressure, bounded fetches, public webhook SSRF controls, quotas, truthful source
  health, atomic publication/review receipts, schema readiness, and preview/production migration
  parity are in `codex/app-hardening-integration`. Final semantic review PASS; real SQLite coverage
  applies all migrations, compares the admin migration tail, runs readiness, and executes
  idempotent transaction/cursor/estimate/outbox writes. Deployed in PR #284; tracked by the deployed
  program row above.
- **Billing + platform security hardening (CODEX, M) — INTEGRATED LOCALLY + ADVERSARIALLY REVIEWED
  2026-07-11; FINAL PROGRAM GATES PASS.** Lane branch `codex/billing-security-hardening`;
  integration branch `codex/app-hardening-integration`.
  Adds reclaimable Stripe event leases, stale/deletion ordering, non-overwriting customer links,
  mandatory stable checkout/portal idempotency keys, the Managed-Payments-compatible Basil pin,
  split checkout/portal readiness with the legacy `configured` alias, dual cookie/bearer logout,
  fail-closed resolver use, browser security headers, and CI coverage floors. Review fixes prevent
  malformed supported events from being silently acknowledged, handle expanded Stripe IDs, permit
  safe same-second terminal-to-active resubscription across subscription IDs, and keep Billing
  Portal available to existing payers when checkout configuration is incomplete. Verified: 79 test
  files / 714 tests, typecheck, coverage 64.11/56.61/69.46/65.92, lint 0 errors, `npm audit` 0
  vulnerabilities, fresh migration through 0032, and `git diff --check`; the integrated 808-test
  gate and isolated preview also pass. The hardened billing code is live in production;
  checkout/portal capability remains unconfigured, and no billing activation was performed.
- **iOS client correctness + performance hardening (CODEX/HUBBLE, L) — INTEGRATED LOCALLY + REVIEWED
  2026-07-11; FINAL PROGRAM GATES PASS.** Lane branch `codex/ios-client-hardening`;
  integration branch `codex/app-hardening-integration`.
  Preserves one-time delivery credentials, sends active-only subscription patches, hydrates server
  preferences before edit, retains UUID intent keys for uncertain retries, revokes bearer sessions,
  and adds feature-local state, offline/cache limits, accessibility, formatter/search improvements,
  an XCTest target, and a compiled 1024x1024 opaque AppIcon/accent-color catalog derived from the
  existing PWA mark. Generic Simulator build, build-for-testing, compiled icon inspection, asset
  validation, and `git diff --check` pass; test execution awaits a concrete installed Simulator
  runtime. Source is merged to `main`; no signing/App Store production target is configured.
- **PWA release hardening + CI coverage (CODEX/VOLTA, L) — INTEGRATED LOCALLY 2026-07-11;
  FINAL PROGRAM GATES PASS.** Lane branch `codex/pwa-release-hardening`; integration branch
  `codex/app-hardening-integration` rebased onto current `origin/main` after AG's PR #266 merged.
  AG's corrected handoff `c6201fb` was integrated as `6456cb8`; Codex added server-backed
  latest-first filters, runtime `estValue`, saved-preference hydration/failure locking, auth-gated
  writes, UUID intent keys retained for uncertain retries, one-time delivery credential handling,
  an accessible filter dialog, same-origin docs, focused Vitest coverage, and a PWA CI audit/build
  gate. Integration adds 192/512/maskable/Apple PNG icons plus a registered service worker with
  network-first navigation caching and an offline fallback; API requests are never cached. Verified:
  PWA `npm audit` (0 vulnerabilities), typecheck, 13 tests, production build, generated-manifest/SW
  syntax/icon inspection; desktop/mobile rendered QA with zero overflow or console errors; and a
  readable API-unavailable state. Source is merged to `main`; no same-origin PWA production hosting
  target or reverse-proxy route is configured.
- **Implement `est_value` column in transactions table (AG, S) — COMPLETED 2026-07-11.** Creating D1 migration and updating normalizer to persist `est_value` to simplify API client queries and improve Next.js/PWA performance.
- **Refactor client API routes (AG, M) — COMPLETED 2026-07-11.** Splitting the 800-line `app/src/client/routes.ts` into a clean modular structure (helpers, queries, commands, auth).
- **GPT-5.6 bake-off evaluation prep + usage/cost tracking harness (MONET, S)** — BUILT + PUSHED
  2026-07-10, PR #264. Owner asked to evaluate GPT-5.6 (sol/terra/luna, released 2026-07-09) for
  the extraction pipeline. Research found no evidence of a capability uplift for this document type
  (LlamaIndex ParseBench: "no change" vs GPT-5.5 on tables/text/charts/layout for insurance/finance/
  government docs) and an unconfirmed PDF-input risk on the cheap luna tier — explicitly NOT
  recommending an adoption based on benchmark claims alone, same discipline that would have caught
  the gpt-4o-mini regression fixed in #263. Instead: confirmed the bake-off harness already accepts
  arbitrary {provider,model} pairs with zero code change needed to actually test GPT-5.6 (verified
  exact slugs: gpt-5.6-sol/-terra/-luna), but found it captures NO token-usage/cost data at all —
  built that as a small additive harness extension (CandidateDocResult.usage, runOpenAi usage
  parsing, migration 0025_extraction_runs_usage.sql, INSERT persist). Adversarial verify: NO DEFECTS
  (existing gpt-4o path byte-identical, migration mirror matches, null-safe, other adapters
  untouched). Gate: tsc clean, 76 files/677 tests, independently re-verified. BLOCKED on executing
  the actual comparison run: needs OPENAI_API_KEY (local wrangler dev, preferred) or ADMIN_TOKEN
  (prod) — neither available to this session (Cloudflare Worker secrets are write-only). Handed
  owner 3 ready-to-run scripts (slug-verification ping, the n=20/4-model bakeoff call, a cost-rollup
  reading usage_json against published per-tier pricing) — owner can run + share results, or hand
  over a credential.
- **Fix dead auto-publish gate: AGREEMENT_AUTOPUBLISH_MODEL_B was broken 2 weeks (MONET, S) —
  BUILT + PUSHED 2026-07-10, PR #263.** Owner asked to compare Model B options; investigation +
  live production D1 query (review_queue.agreement_attempted_at/resolved) found the tier-1
  cross-vendor auto-publish gate has been effectively DEAD since 2026-06-26 (commit 500a887 switched
  MODEL_B to openai:gpt-4o-mini, which bakeoff.ts:38 already documented as instant-4xx-rejecting
  this pipeline's PDF payload shape): 30 consecutive resolved=0 attempts since the switch, only
  successes cluster within 6min of the switch timestamp (rollout-artifact stale isolates), then zero
  for 2 straight weeks through today. Fixed by switching to openai:gpt-4o (full) — proven working in
  this exact pipeline (15/15 successful bakeoff extraction_runs on real filings), stays cross-vendor
  from Model A (mistral:mistral-ocr-latest). Verify: tsc clean, 76 files/672 tests, config-only
  change. Also noted (not fixed, separate scope): code fallback default mismatches wrangler.toml
  (dead today, only matters if var ever unset); no live admin UI exists for A/B — the
  'llamaparse:cost-effective' value the owner saw is a stale .dev.vars.example comment never read
  by any code path.
- **FMP pacer safety + shared-budget accounting + EDGAR throttle (MONET, M)** — IN PROGRESS 2026-07-10,
  owner-directed, branch `monet/fmp-edgar-throttle`. Investigation (file:line receipts): FMP
  `FMP_MAX_PER_MINUTE` pacer (`shared/pace.ts`) is per-isolate in-memory with NO cross-invocation
  coordination; disclosure-latency probe (`ingestion/fmpDisclosureLatency.ts`, the "race to file" FMP
  vs Unusual Whales vs Quiver comparison) makes 2 unpaced FMP calls every ~5min (~576/day), invisible
  to the daily KV counter, plus an unthrottled force-probe admin endpoint — real correctness gap, not
  just theoretical. Fix: single shared FMP pacer singleton used by enrichment/prices/disclosure-latency
  so same-isolate concurrent invocations actually coordinate; disclosure-latency's calls now count
  against the same daily budget; FMP_MAX_PER_MINUTE raised with margin (not to 300, per owner ask for
  ~290 — see PR for exact value + rationale). Separately: SEC EDGAR calls were fully unthrottled
  ("free + unmetered" comment) — added a dedicated `createPacer` instance (5 req/s, half SEC's 10 req/s
  fair-access ceiling, margin for Workers' shared egress-IP pool) via new `EDGAR_MAX_PER_MINUTE` env
  var, reusing the existing pace.ts utility rather than building new. Cross-app FMP-data sharing
  (Congress.Trade <-> Socratic.Trade) investigated separately: mechanism is ALREADY fully built,
  bidirectional, wired into cron on both sides (docs/fmp-data-sharing.md <-> Socratic's
  docs/congress-trade-share.md) — nothing to code; only 4 secret/env values across 2 platforms need
  owner confirmation/activation (not done by this row — config/secrets decision, not code).
  2026-07-10 (MONET): BUILT + COMMITTED + PUSHED — PR #262. Two build passes: (1) shared FMP pacer
  singleton fixing a real concurrency race (reservation-gate design after adversarial verify caught
  the original sleep-based design failing under Promise.all-concurrent callers), disclosure-latency
  probe's ~576/day previously-unpaced-and-uncounted FMP calls now share the same pacer + daily budget
  counter, FMP_MAX_PER_MINUTE 250->285, dedicated EDGAR pacer added (was fully unthrottled) at
  EDGAR_MAX_PER_MINUTE=480 (8 req/s, owner-chosen over the initially-recommended 5 req/s); (2) full
  wrangler.toml [vars] audit (22 entries: 6 already-live, 16 needs-wiring, 0 ambiguous) -> all 16 wired
  through the existing resolveSecret/resolveSecrets mechanism (same pattern as FMP_DAILY_CALL_CAP, no
  runtime allowlist so pure read-site swaps) with the current wrangler.toml value kept as automatic
  fallback (zero-regression-when-unset invariant adversarially verified: fallback-value transcription,
  string/bool/number re-parse bugs, missed awaits on 2 sync->async conversions — all clean); plus a new
  Tiingo fallback enrichment+price provider (key-gated, mirrors Massive/Finnhub pattern, no-op until
  TIINGO_API_KEY provisioned). Independent re-verify (not just agent-reported): tsc clean, 705/705
  tests / 78 files, actual wrangler.toml values confirmed by direct read. 18-entry copy-pasteable
  Infisical checklist in the PR body. Owner action needed: paste checklist into Infisical (this PR
  changes nothing behaviorally on its own) + optionally provision TIINGO_API_KEY.
- **Review-queue automation: model choice + multi-model consensus + escalation cascade (MONET, L)** —
  IN PROGRESS 2026-07-10, owner-directed ("do all 3 phases"), branch `monet/review-queue-automation`.
  Builds on the existing agreement/bakeoff machinery (audit w/ file:line receipts 2026-07-10):
  P1 persist agreement-model readings to `extraction_runs` + review-UI "Re-read with model…" (bakeoff
  endpoint already supports it) + `VISION_PRIMARY_MODEL` env override for the hardcoded vision model;
  P2 new `consensus.ts` per-transaction per-field majority vote ({value, votes, dissenters}) +
  consensus block on GET /review/:docId/extractions + UI superimposition grid (consensus vs outliers)
  + "Use Consensus" prefill; P3 escalation cascade in `processAgreementDoc` (tiered: pair → +model C →
  2-of-3 majority publish gated on per-field majority + hard-fail flags), capped attempts replacing the
  once-ever stamp, page_count/raw_bytes complexity signals, daily LLM budget guardrail, distinct audit
  trail for machine-resolved docs. Tiered subagents (haiku=mechanical, sonnet=implementation,
  opus=cascade/consensus + adversarial verify). Gates: typecheck + full test suite + adversarial review
  before commit. KEEPOUT: nothing outside app/src/{extraction,admin,ui,shared}, app/migrations,
  wrangler.toml [vars]; not touching other seats' rows/files.
  2026-07-10 (MONET): BUILT + COMMITTED locally (`46f80cc`, 24 files, +2983/−93; migrations 0025-0027
  mirrored in admin migrate per repo rule; mirror row updated in-branch). 15 subagents, all lanes green;
  4-lens adversarial verify caught + FIXED 3 real defects pre-commit (tier-3 multi-lot drop →
  bail-to-review guard; duplicate-model-id false 2-of-3 majority → distinct-voter electorate; UI
  minority-row prefill → row-majority gate); 1 finding refuted with rationale. Independent final gates:
  typecheck clean, 718/718 tests / 82 files. NOT pushed — awaiting owner push/PR approval.
- **Consolidate usage telemetry clients in consumer apps (AG) - COMPLETED 2026-07-06.** Replacing hand-rolled usage telemetry clients with `@jaywedgeworth22/congress-trading-shared` in Congress.Trade.
- **Codebase Performance & Queues (AG, M) — COMPLETED 2026-07-11.** Fix silent DLQ webhook failures, implement `DB.batch` for `persistTransactions`, use `sendBatch` for queue dispatching, and run webhook fetch requests concurrently.

- Codex global coordination + fleet monitoring setup (Codex, shared `/Users/jay/apps`
  infra) — ensure Congress.Trade is included in the standardized effort-log
  registry and future-repo bootstrap path without editing non-Codex app code.
  2026-07-05 (Codex): corrected stale row after recheck — PR #137
  (`codex/agent-coordination-bootstrap`) is merged as `4f327be5`; docs-only,
  checks green, no preview or production deploy.
- **Codex Cloud Slack + effort-log readiness across all four apps (CODEX, shared fleet-infra) —
  DONE-local 2026-07-05; awaiting owner approval to push/open PRs.** Scope: audit/standardize Codex Cloud repo-visible setup so remote
  Codex sessions can read `docs/EFFORT-LOG.md` and use #agent-sync with the configured
  `SLACK_AGENT_NAME`, `SLACK_CHANNEL_ID`, `SLACK_PROJECT`, and runtime token/env settings. Keep
  work out of dirty Cursor/Monet worktrees; reuse/adapt the closed PR #367 Slack helper rather than
  creating a competing Slack Socket Mode client. Cross-app rows mirrored in the other live boards.
  _2026-07-05 (CLAUDE audit-c3): reassigned CODEX -> CLAUDE (Codex capped to Jul 8 18:10 CT).
  Verified: board says "DONE-local 2026-07-05; awaiting owner approval to push". Confirmed
  `codex/cloud-slack-effort-log` NOT on origin (`git ls-remote` empty), no PR (`gh pr list` empty).
  Codex cannot push/finish it itself while capped. action=open-PR; CLAUDE picks this up. [CODEX ->
  CLAUDE]._
- **Sentry CI failure reporter (MONET, S)** — IN PROGRESS 2026-07-05, implemented locally on branch
  `monet/sentry-ci-report`; NOT pushed/merged (repo rule: no push/deploy without owner). Added the
  additive fleet-standard `.github/workflows/sentry-ci-report.yml` (`workflow_run` observer) +
  `scripts/sentry-ci-report.py` (raw Sentry envelope reporter → shared `fleet-infra` project, org
  jays-services, via repo secret `SENTRY_FLEET_DSN`), adapted from the Socratic.Trade canonical.
  Repo-specific adaptations: observed-workflow list + `CRON_SCHEDULES` reflect THIS repo (observes CI,
  Codex Autofix, Deploy Preview, Deploy, Effort Issues Sync, Shared package pin check, Security; cron
  check-ins for the 3 scheduled ones); added an `app:congress-trade` tag + fingerprint component (the
  shared fleet-infra project would otherwise dedup Congress.Trade "CI"/"Deploy"/"Security" failures
  with Socratic.Trade's); deliberately EXCLUDED the `*/5` Uptime Monitor (~288 reporter runs/day /
  ~2880 Actions-min/mo + wrong check-in margin), documented in the yml header. Verify: `tsc` clean +
  77 files/673 tests pass; `py_compile` + pure-function + behavioral (monkeypatched envelope, scenario
  matrix A–E) tests pass; 4-lens adversarial review (repo-fit, security, spec-conformance/canonical-
  parity, behavioral) all PASS. Owner action needed: add the `SENTRY_FLEET_DSN` repo secret (script
  no-ops safely until then).
  2026-07-05 (MONET, re-verify after `main` advanced to `2a4fe82`): 2 adversarial subagents confirm ZERO
  drift (7 observed workflow `name:` still match; 3 `CRON_SCHEDULES` still match live `schedule:`) and
  `git merge-tree` LANDS CLEANLY (no overlap with CURSOR's active `.github/workflows/*` CI-cleanup —
  same-dir/different-file; CURSOR edits only `permissions:`, never `name:`/`schedule:`). Fail-safe
  HARDENED on branch (amended, still unpushed): a malformed/rotated DSN now emits `::error::` + exits 0
  (was `return 1`) so it can never red-X observed workflows. Re-verified `py_compile` + behavioral
  (malformed/empty/benign all exit 0) + no-DSN-leak. Still blocked on owner push/PR + `SENTRY_FLEET_DSN`
  secret.
  2026-07-05 (MONET): owner authorized push. Rebased clean onto `da03ebb` and DROPPED the branch's
  `docs/EFFORT-LOG.md` hunk (main already carries this row via the #164 mirror-sync), reducing the
  branch to a minimal 2-file additive change (`sentry-ci-report.yml` + `sentry-ci-report.py`). Final
  independent push-readiness audit = PUSH-READY (2 files, clean 3-way merge, secret-safe + exit-0 on
  every path, zero workflow/cron drift). Pushed + opened **PR #181**. All checks GREEN (autofix,
  gitleaks, typecheck+test); MERGEABLE, mergeState BLOCKED only on the required-review rule.
  CORRECTION: the `SENTRY_FLEET_DSN` repo secret is ALREADY set on Congress.Trade (verified via
  `gh secret list`), so no secret step is needed — merging PR #181 makes the reporter live immediately.
  ONLY remaining step: owner review/merge. (FYI fleet gap: `SENTRY_FLEET_DSN` is NOT set on
  congress-trading-shared or API-usage-monitor, so their sentry-ci-report workflows silently no-op.)
- **Congress.Trade Improvements (AG, M) — COMPLETED 2026-07-11 (PR #266 merged).** Comprehensive UI, data sharing, and scraping improvements on branch `ag/client-and-ticker`.
  1. [x] **UI/UX Mobile Refactor**: Implement responsive cards/scroll for data tables in `dashboardHtml.ts`.
  2. [x] **Shared Ticker Aliases**: Move ticker alias resolution logic into `congress-trading-shared`.
  3. [x] **Typed API Client SDK**: Build and export a strongly-typed `CongressTradeClient` in the shared repo.
  4. [x] **Senate Scraper Handshake**: Implement Cloudflare KV session caching for the Senate eFD agreement gate.
  _2026-07-05 (CLAUDE audit-c3): ABANDONED/HANGING annotation — the shared-package half this row
  depends on is blocking it. `congress-trading-shared` branch `ag/client-and-ticker` head `4d50cb2`
  (commit `81b2fd3`: client.ts + constants split) is NOT in shared `main` (`git branch --merged
  origin/main`: not present) and NOT in tag `v1.3.0` (`4c35df2`; ag head is 2 commits ahead). No open
  PR exists on the shared repo for this branch. Consequence: this PR and its 5 siblings (#183-#187)
  all pin `#ag/client-and-ticker` and fail required check-pin DIVERGED vs peer `v1.2.0`.
  action=land-it (shared-repo side) — see the new "Merge shared ag/client-and-ticker + release
  v1.3.1" Planned row below. [AG -> AG]._
- **Acquisition-vs-rename guard for ticker aliases (AG, M, cross-app) — COMPLETED 2026-07-11.** Upstream fold sites in `normalizer.ts` and `tickerNormalize.ts` migrated to `resolveContinuousTicker` / `TICKER_RENAMES` to ensure acquisitions remain distinct, and `pitScores.ts` updated to classify prior tickers and delisted flag.
- **Congress push/SSE contract repair (AG, M, cross-app) — COMPLETED 2026-07-11.** Replaced database queries with a single joined query, formatted `trades` array payload, and attached bearer `Authorization` headers.
- **Prep the shared-pkg v1.3.0 adoption PR as a matched pair behind the owner tag (AG, M) — COMPLETED 2026-07-11.** Pin `ag/client-and-ticker` branch version in App A package.json.
  _2026-07-05 (CLAUDE audit-c3): ABANDONED/HANGING annotation — the "Antigravity six-PR pileup"
  #182-#187 (client-and-ticker, data-sharing, ui-ux-refactor, senate-scraper, performance-queues,
  fix-d1-overload): all six OPEN, mergeable=MERGEABLE but mergeState=BLOCKED, each failing ONLY
  check-pin (verified via `gh pr checks`). Diffs overlap massively — every branch carries the same
  231-line `senateSource.ts` rewrite + `tickerNormalize` + `eslint.config.mjs` + `vitest.config.ts` +
  `package.json` pin, differing by only 1-2 unique files (e.g. #184 dashboardHtml, #187
  fmpDisclosureLatency+client routes, #185 shared/types+assetTypes). Landing them in parallel
  guarantees conflicts. Board previously mislabeled #185 as COMPLETED though it is OPEN/BLOCKED —
  corrected: it is IN PROGRESS/BLOCKED like its siblings. action=reclaim-and-finish; see the new
  "Consolidate AG's six overlapping PRs" Planned row below. [AG -> AG]._
  Additionally: PR #186 (`antigravity/performance-queues`) has a stray build-artifact `patch.py`
  committed (`git show origin/antigravity/performance-queues:patch.py` = a 47-line Python
  sed-style script that string-patches `app/src/delivery/webhook.ts` — a scratch tool accidentally
  committed, not product code) that must be removed before it lands. action=reclaim-and-finish.
  [AG -> AG].

## Planned / Reserved
- **Post-Codex Activation: PWA/iOS deploy targets, billing config, ingestion and queue drain (AG, XL) — 2026-07-11.** Take over execution from Codex, define production hosting for PWA/iOS, configure billing portal, and execute backlog ingestion/backfill.
- **Senate Scraper Hardening (AG, M) — 2026-07-05.** Overcome WAF IP blocks via residential scout proxying, implement content-based field extraction for DataTables, and cache session handshakes in KV.
- **UI/UX Improvements (AG, M) — 2026-07-05.** Fix mobile tab grid spacing, hide mobile columns button, consolidate search/filters + add Max $, fix theme toggle labels, group pagination controls, sticky-lock columns, and add charts to Trends.
- **Architecture & Shared Dependency (AG, M) — 2026-07-05.** Use `createCongressEvent` from shared package, promote duplicate types to `schemas.ts`, upgrade Socratic.Trade to validate HMAC `X-Signature`, and replace SSE D1-polling with a push mechanism.

_2026-07-04 backlog exhaustiveness pass (CLAUDE, owner-directed). Tags: CURSOR = Cursor background
agents (DeepSeek v4 Pro), CODEX = Codex, AG = Antigravity/Gemini, CLAUDE = Claude Code. Assignments
are reservations, not locks — re-negotiate in #agent-sync._

- **Sentry CI failure reporter (CLAUDE, S)** — copy the additive `sentry-ci-report.yml` fleet
  standard from Socratic.Trade per AGENT-SYNC.md observability rules. **MONET (Claude seat) claimed
  2026-07-05 → see In Progress; implemented + verified locally on `monet/sentry-ci-report`, awaiting
  owner push/PR.**
- **Promote shared-package-pin-check to a required check (unassigned, S)** — deferred in the
  workflow's own header until shared-pkg bumps always land as matched pairs.
- **Owner decision: should public subscription creation require login? (unassigned, M)** —
  AGENTS.md "Open Decisions To Preserve".
- **Owner decision: should analytics routes become premium-only? (unassigned, M)** — AGENTS.md
  "Open Decisions To Preserve".
- **Wave 4 go-live: configure auth + Stripe paywall services (unassigned, M)** — board reservation
  for hand-made issue #20, which stays canonical.

### 2026-07-05 next-wave (cycle 2)

_Generated by CLAUDE next-wave pass. LOAD NOTES: CLAUDE lane free (merged #141, #162, no open
branch). CODEX lane free as of #160's merge. CURSOR lane output-blocked (6 tasks done but
uncommitted on `cursor/assigned-tasks` in the dirty primary checkout, 7 merges behind base —
unusable for others until landed). MONET lane blocked on the owner twice over (unpushed
`monet/sentry-ci-report` needs `SENTRY_FLEET_DSN`; shared-repo v1.3.0 unpushed/untagged). AG lane
looks dead — both 2026-07-04 reservations show zero activity; if AG stays silent in #agent-sync,
reassign per the rows below. OWNER is the true bottleneck: land the cursor branch, push two MONET
branches, tag v1.3.0, set `STRIPE_*`/`SENTRY_FLEET_DSN` secrets, decide the Cloudflare health-check
bypass, and adjudicate the two open product decisions above._

- **Fix the production deploy health gate blocked by Cloudflare managed challenge (CURSOR, M) — COMPLETED 2026-07-06; COMMITTED 2026-07-08 via PR #237 (`cursor/rollouts-health-gate`).**
  All 3 recent Deploy runs 403'd on `/api/health` from GH runners (challenge page, `cType`
  `'managed'`); add a WAF skip/custom rule or secret-header bypass for `/api/health` (or fall back
  to the `workers.dev` hostname), then rerun Deploy end-to-end. Why now: the browser-UA workaround
  merged 7/2 (`e320b1a`) demonstrably failed on the 7/3 run — a UA string cannot pass a managed
  challenge from datacenter IPs; until fixed, `ship.sh` exits before `POST /api/admin/migrate`, so
  every CI deploy leaves prod schema unverified and Wave-4 go-live (which needs migrations) cannot
  ship confidently.
- **De-crash and de-challenge the Uptime Monitor workflow (CURSOR, S) — COMPLETED 2026-07-06.** `uptime-monitor.yml` does
  a bare curl (no UA/bypass) so it fetches challenge HTML, then writes that body to
  `GITHUB_OUTPUT` with a static `EOF` heredoc that crashes ("Matching delimiter not found"); use a
  random delimiter + truncate/sanitize the body + apply the same health-check bypass as deploy. Why
  now: every scheduled run today is red for the wrong reason — the monitor can't distinguish "site
  down" from "monitor broken", which defeats its purpose and trains everyone to ignore red runs.
- **Audit production schema drift from the three failed Deploy runs (OWNER, S)** — Confirm whether
  `POST /api/admin/migrate` ever ran after the 6/30, 7/2, 7/3 Worker uploads (deploy exits before
  migrate on health failure); if behind, run the guarded `ship.sh` migrate path from the Mac. Why
  now: prod is running version `eafb0a16` deployed 7/3 but the pipeline never reached the migrate
  step in any recent run; if any of those merges included migrations (e.g. 0009_client_api.sql era
  or later), prod code and schema may be silently divergent.
- **Land cursor/assigned-tasks: commit, rebase onto main, drop already-merged hunks (CURSOR, M) — COMPLETED 2026-07-06.**
  The branch is uncommitted in `/Users/jay/Code/Congress.Trade` on base `892b45e` (7 merges
  behind); its task 7 (tokenless dep: `app/.npmrc` delete, `package.json` switch) and parts of the
  CI cleanup duplicate merged PRs #139/#140 — commit, merge origin/main, drop redundant hunks, keep
  the still-missing `PEER_REPO` fix (main still says `agentic-trading`), re-verify, open PR. Why
  now: the board marks this Completed but there is no landing row; the genuinely-new work (ESLint
  bootstrap, vitest config, PEER_REPO fix, tsconfig.ingestcheck removal) is stranded, and the dirty
  primary checkout blocks anyone else using that worktree.

- **Adopt the docs/rollouts/ note convention in Congress.Trade AGENTS.md (CURSOR, S) — COMPLETED 2026-07-06; COMMITTED 2026-07-08 via PR #237 (`cursor/rollouts-health-gate`).** Add the
  Socratic.Trade-style `docs/rollouts/YYYY-MM-DD-slug.md` convention (summary/why/files/
  verification/follow-ups) to AGENTS.md and seed the directory; STATUS.md stays the snapshot. Why
  now: this repo's only paper trail is a single overwritten STATUS.md — the #139 tokenless-dep
  work explicitly noted it had nowhere durable to record its proof; with 5 agent lanes and a
  go-live approaching, chronological decision records are the cheapest coordination insurance and
  match the fleet standard.
- **De-duplicate effort-issues sync when a row's first line changes (CLAUDE, S)** —
  `scripts/sync-effort-issues.py` keys issues on the row title line, so editing a row (e.g.
  appending "IN PROGRESS 2026-07-04") minted a second issue — #161 duplicates #146 for the same
  effort; match on a stable slug or fuzzy-prefix and close superseded twins. Why now: fresh
  concrete failure visible on the board today; CLAUDE owns this fleet-standard script (just
  hardened it in #162/#694) so the fix propagates to all four repos.

### 2026-07-05 audit cycle-3
_Added by CLAUDE audit-c3 pass. Tags: CURSOR / CODEX / AG / MONET / CLAUDE / OWNER. Assignments are
reservations, not locks — re-negotiate in #agent-sync. NEVER assign to CODEX (quota-capped to
Jul 8 18:10 CT)._

- **Merge shared ag/client-and-ticker + release v1.3.1 so app PRs can pin a tag not a branch (AG, M) — COMPLETED 2026-07-11** — The shared repo's ag/client-and-ticker (commit 81b2fd3: CongressTradeClient + ticker rename/acquisition split) is unmerged and absent from v1.3.0. Every Congress.Trade PR #182-#187 fails check-pin because it must pin the branch. Merge the shared branch to shared main, cut v1.3.1, then repin app/package.json (and Socratic.Trade's peer) to that tag as a matched pair so check-pin goes green.
- **Consolidate AG's six overlapping PRs #182-#187 into one stacked/sequenced landing plan (AG, L) — COMPLETED 2026-07-11.** — The six AG branches each re-include the same 231-line senateSource rewrite + tickerNormalize + eslint/vitest config, so parallel merges will conflict. Pick a single base branch, rebase the unique deltas (dashboardHtml, fmpDisclosureLatency, shared/types dedup, D1-batch/queue perf, senate KV caching) on top of it in order, and close the redundant duplicates — after the shared v1.3.1 tag exists so check-pin can pass.
- **Remove stray patch.py scratch script from antigravity/performance-queues (#186) before it lands (AG, S) — COMPLETED 2026-07-11.** — PR #186 accidentally commits patch.py, a 47-line Python string-patcher for webhook.ts. Delete it so a dev-only artifact does not ship into the repo.
- **Rescue CURSOR stash into a committed, pushed branch + PR (CURSOR, M) — MERGED 2026-07-08 via PR #211 (`ef732f3`).** PR #211 (`cursor/assigned-tasks-v2`). Stash@{1} rescued from base 892b45e onto current origin/main. Dropped already-merged hunks from #139/#140. Genuine work committed: tsconfig strict flags, tsconfig.ingestcheck deletion, ESLint deps + scripts, lockfile-based pin-check, AGENTS.md dedup, unused-code removal across 8 files, dashboard CSS cleanup. Gates: typecheck 0 errors, lint 0 errors, 672 tests pass.
- **Add manual queue reprocess button to admin dashboard (AG, S) — COMPLETED 2026-07-06.** Added a UI widget to `dashboardHtml.ts` to trigger `POST /api/admin/reprocess` directly from the admin panel.

## Changelog of this log
- 2026-07-08 — CURSOR: PR #211 merged; PR #237 opened (rollouts convention + deploy health gate workers.dev fallback, previously stranded in stash@{1}).
- 2026-07-06 — CURSOR: rescued stash@{1} → PR #211; fixed uptime-monitor.yml crash + CF challenge bypass; adopted rollouts convention; created Wave-4 smoke script; fixed deploy health gate (workers.dev fallback); noted patch.py on AG's PR #186.
- 2026-07-05 — CLAUDE next-wave (cycle 2): stale-row corrections (tokenless-dep switch and
  house-live-search moved to Completed; #139 docs-convention parenthetical amended; Deployed
  section corrected to record 3 failed-health-gate deploys; mirror-staleness and STATUS.md
  staleness flagged) + 9 new Planned rows added under "2026-07-05 next-wave (cycle 2)".
- 2026-07-05 — CURSOR: completed all 6 assigned backlog tasks + tokenless git dep fix; moved from Planned → Completed.
- 2026-07-04 — bootstrapped by CODEX for the all-app coordination protocol.
- 2026-07-04 — CLAUDE: backlog exhaustiveness + assignment pass (owner-directed); seeded the
  Planned section from a full repo audit. Issues-mirror bootstrap (sync script + workflow +
  populated repo mirror) in flight on a CLAUDE branch, building on Codex PR #137.
- 2026-07-05 (CLAUDE audit-c3) - Audit cycle-3 pass: annotated ABANDONED/HANGING rows — AG's shared-
  package dependency block (ag/client-and-ticker unmerged, blocks PRs #182-#187 check-pin), the
  6-PR AG pileup #182-#187 (corrected #185's mislabeled COMPLETED to OPEN/BLOCKED), the stray
  patch.py in #186, the CURSOR cursor/assigned-tasks stash@{0} strand (corrected false COMPLETED
  claim), and Codex's DONE-local cloud-slack-effort-log work (reassigned CODEX -> CLAUDE, capped to
  Jul 8). Reassigned two CODEX-owned cycle-2 Planned rows off Codex: Wave-4 go-live smoke script ->
  CLAUDE, live-search reconciliation data-quality job -> AG. Added 4 new Planned rows under
  "2026-07-05 audit cycle-3": merge shared v1.3.1 (AG), consolidate the 6 AG PRs (AG), remove
  patch.py (AG), rescue CURSOR's stash (CURSOR).
- **Whole-App Evaluation & Next.js PWA Implementation (AG, L) — COMPLETED 2026-07-11.** Refactored monolithic backend routes to a layered architecture (types, queries, utils, routes), implemented the `est_value` materialized column in D1 to optimize feed queries, and established the Next.js PWA frontend using SWR for data fetching, responsive glassmorphism dark-mode UI, and reusable components like `TradeCard`. 

- **Bump shared to v1.5.0 (AG, S) — COMPLETED 2026-07-11.** Exact git-tag pin `#v1.5.0` resolves `2222baeb`; `^1.5.0` in the original row was wording-only and incorrect. Canonical status is the matched-pin row under In Progress above.
- **Resolve Audit Tier 1 Fixes (AG, S) — COMPLETED 2026-07-12.** — PR 339. Addressed review feedback regarding `duplicateLineupReason` and model configurations in `agreement.ts`, removed single-model benchmark lineups to fix meaningless autonomy stats, pinned dependencies, resolved all review threads, merged PR, and deployed to production.
- **Dashboard Interactivity & Visual Toggles (AG, M) — COMPLETED 2026-07-12.** — PR 345. Added interactive tooltips to the time chart, implemented a Trade vs Dollars metric toggle, replaced top filter dropdowns with visual emoji toggles, centralized timeframe selection to a global variable, explicitly labeled data tally vs dollar volume, and centered the small KPI cards.
- **Review Queue Quick Run (AG, S) — COMPLETED 2026-07-12.** — PR 345 (merged with Interactivity). Added a "Run Model" dropdown to each row in the review queue to easily retry specific models without terminal scripts.
- **Admin Infisical Secrets Update (AG, S) — COMPLETED 2026-07-12.** — Added capability to update Infisical secrets directly from the Admin page via `POST /api/v3/secrets/raw` (supporting both updates and creation) and integrated it into the UI under the Diagnostics tab.
- **Historic Backfill for Executive Branches (AG, S) — COMPLETED 2026-07-12.** — PR 348. Added the Executive Branch backfill button to the admin dashboard, pointing to the existing POST /api/admin/oge-backfill endpoint to allow for historical ingestion of President and VP transaction reports.
- **Split Prompts by Chamber & Fix Extraction compilation (AG, S) — COMPLETED 2026-07-12.** — Split SYSTEM_PROMPT into HOUSE, SENATE, and EXECUTIVE prompts in visionLlm.ts to prevent extraction hallucinations across form types. Updated batchExtract.ts and bakeoff.ts to dynamically select prompts. Fixed LlamaParse extraction errors for Executive branch forms.
- **2026-07-12** - `[Congress.Trade]`: Admin Dashboard UI Fixes (AG) - Removed vague 'Source' column, updated default visible columns to include Sector and Market Cap, fixed default sorting to txdate, and disabled CSS proportionate column width squishing to enable horizontal scrolling.
- **Benchmark Autonomy & Accuracy Breakdown (AG, M) — COMPLETED 2026-07-13.** Added ground-truth accuracy tracking, perfect-match rate check, and F1-score details to model benchmarks. Built an interactive Consensus Cascade simulation panel to test any Model A / Model B / Model C configurations and view live simulated autonomy rates, accuracies, human review rates, and relative cost per document. Deployed to production.

- **2026-07-13** - `[Congress.Trade]`: Merged outstanding PRs (368, 365, 364, 363) and deployed to production (AG)
- **UI/UX Audit Fixes (AG, M) — COMPLETED 2026-07-15.** Implemented audit feedback across `dashboardHtml.ts` and `clients/pwa/`: applied "Inter" font and `tabular-nums` for typography, added subtle inner borders for glassmorphism panels, integrated staggered keyframe animations and spring-physics easing for interactive elements, fixed mobile grid overflows, replaced visual `<b>` tags with semantic `<span>` tags, migrated filter sheets to native `<dialog>` for proper focus trapping, and resolved all build/test regressions. Changes merged via PR #419 and deployed to production.

- **Switch to Cheapest OpenRouter Models (AG, S) — COMPLETED 2026-07-16.** Switched AGREEMENT_AUTOPUBLISH_MODEL_A, B, and C in wrangler.toml to the cheapest capable OpenRouter models (gemini-2.5-flash-lite, qwen3-vl-8b-instruct, and nova-lite-v1) per user directive, and deployed to production.

- **Replace Sonnet Models with Sonnet 5 (AG, S) — COMPLETED 2026-07-16.** Removed old claude-sonnet-4-6 and claude-3-5-sonnet slugs across codebase and Infisical, replacing them with claude-sonnet-5 to take advantage of introductory pricing.- **Migrate to OpenRouter Extraction Architecture (AG, M) — COMPLETED 2026-07-16.** Consolidated the vision extraction pipeline around OpenRouter API. Configured dynamic PDF plugin engine selection to leverage native multimodal inputs for supporting models (e.g., GPT-4o, Gemini 1.5) and mistral-ocr for pure-text models. Enforced structured JSON output globally. Also identified that OpenRouter does not support asynchronous batch completions, so the legacy historical batch processing script was left intact on native provider endpoints.
