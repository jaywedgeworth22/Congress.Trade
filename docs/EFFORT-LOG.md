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
- (record production Worker releases here after explicit owner-approved deploys)
- 2026-07-05 (CLAUDE next-wave) correction: this section read as empty/no-deploys, but production
  actually received Worker uploads on **6/30, 7/2, and 7/3** via Deploy runs that then **FAILED the
  health gate** (health check 403'd on a Cloudflare managed challenge from the GH runner IP, so the
  `POST /api/admin/migrate` step never ran in any of the three). Production is currently running
  Worker version `eafb0a16` (deployed 7/3) in this unverified state — code shipped, but whether the
  D1 schema is in sync with that code is **unconfirmed**. See new Planned rows below (Cloudflare
  health-gate bypass; schema-drift audit) for the fix and follow-up.

## Completed
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
- **CURSOR-assigned backlog tasks (CURSOR, `cursor/assigned-tasks`) — COMPLETED 2026-07-05.**
  Six tasks across 3 subagents, all gates green (typecheck clean, lint 0 errors / 64 warnings,
  669 tests pass). Uncommitted on branch; awaits owner review for commit/PR.
  1. **ESLint bootstrap + `noUnusedLocals`/`noUnusedParameters`** — ESLint v10.6.0 flat config
     (`app/eslint.config.mjs`), TS strict flags enabled, 6 violations fixed across 5 files.
  2. **CI cleanup — fix PEER_REPO** → `jaywedgeworth22/Socratic.Trade` in pin-check workflow.
  3. **CI cleanup — port pin-check hardening** — `resolve_installed()` from `package-lock.json`,
     hard-fail on missing peer dep.
  4. **CI cleanup — prune `packages: read`** + dead "Configure GitHub Packages" steps from
     ci/deploy/deploy-staging.
  5. **Vitest config + coverage** — `app/vitest.config.ts` with v8 provider, `"coverage"` script.
  6. **Remove `app/tsconfig.ingestcheck.json`** — zero references anywhere, deleted.
  7. **Fix tokenless git dep** — `app/package.json` switched to
     `github:jaywedgeworth22/congress-trading-shared#semver:^1.2.x`, `app/.npmrc` deleted,
     stub removed, gates re-verified (typecheck clean, 669 tests pass).
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

## In Progress
- **Codebase Performance & Queues (AG, M) — IN PROGRESS 2026-07-05.** Fix silent DLQ webhook failures, implement `DB.batch` for `persistTransactions`, use `sendBatch` for queue dispatching, and run webhook fetch requests concurrently.

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
  every path, zero workflow/cron drift). Pushed + opened **PR #181**. NOW awaiting: owner review/merge
  + adding the `SENTRY_FLEET_DSN` repo secret (no-ops safely until set).
- **Congress.Trade Improvements (AG, M) — IN PROGRESS 2026-07-05 (PR #182 open).** Comprehensive UI, data sharing, and scraping improvements on branch `ag/client-and-ticker`.
  1. [x] **UI/UX Mobile Refactor**: Implement responsive cards/scroll for data tables in `dashboardHtml.ts`.
  2. [x] **Shared Ticker Aliases**: Move ticker alias resolution logic into `congress-trading-shared`.
  3. [x] **Typed API Client SDK**: Build and export a strongly-typed `CongressTradeClient` in the shared repo.
  4. [x] **Senate Scraper Handshake**: Implement Cloudflare KV session caching for the Senate eFD agreement gate.
- **Acquisition-vs-rename guard for ticker aliases (AG, M, cross-app) — IN PROGRESS 2026-07-05 (PR #182 open).** Upstream fold sites in `normalizer.ts` and `tickerNormalize.ts` migrated to `resolveContinuousTicker` / `TICKER_RENAMES` to ensure acquisitions remain distinct, and `pitScores.ts` updated to classify prior tickers and delisted flag.
- **Congress push/SSE contract repair (AG, M, cross-app) — IN PROGRESS 2026-07-05 (PR #182 open).** Replaced database queries with a single joined query, formatted `trades` array payload, and attached bearer `Authorization` headers.
- **Prep the shared-pkg v1.3.0 adoption PR as a matched pair behind the owner tag (AG, M) — IN PROGRESS 2026-07-05 (PR #182 open).** Pin `ag/client-and-ticker` branch version in App A package.json.

## Planned / Reserved
- **Push account status metrics to Usage Monitor (AG) — 2026-07-05.** Send telemetry events with `metricType: "balance"` or `"limit"` to the API Usage Monitor to track tech account caps and credits.
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

- **Fix the production deploy health gate blocked by Cloudflare managed challenge (CLAUDE, M)** —
  All 3 recent Deploy runs 403'd on `/api/health` from GH runners (challenge page, `cType`
  `'managed'`); add a WAF skip/custom rule or secret-header bypass for `/api/health` (or fall back
  to the `workers.dev` hostname), then rerun Deploy end-to-end. Why now: the browser-UA workaround
  merged 7/2 (`e320b1a`) demonstrably failed on the 7/3 run — a UA string cannot pass a managed
  challenge from datacenter IPs; until fixed, `ship.sh` exits before `POST /api/admin/migrate`, so
  every CI deploy leaves prod schema unverified and Wave-4 go-live (which needs migrations) cannot
  ship confidently.
- **De-crash and de-challenge the Uptime Monitor workflow (CURSOR, S)** — `uptime-monitor.yml` does
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
- **Land cursor/assigned-tasks: commit, rebase onto main, drop already-merged hunks (CURSOR, M)** —
  The branch is uncommitted in `/Users/jay/Code/Congress.Trade` on base `892b45e` (7 merges
  behind); its task 7 (tokenless dep: `app/.npmrc` delete, `package.json` switch) and parts of the
  CI cleanup duplicate merged PRs #139/#140 — commit, merge origin/main, drop redundant hunks, keep
  the still-missing `PEER_REPO` fix (main still says `agentic-trading`), re-verify, open PR. Why
  now: the board marks this Completed but there is no landing row; the genuinely-new work (ESLint
  bootstrap, vitest config, PEER_REPO fix, tsconfig.ingestcheck removal) is stranded, and the dirty
  primary checkout blocks anyone else using that worktree.
- **Wave-4 go-live smoke script: auth/me + billing/status + test-mode checkout (CODEX, S)** — Small
  script (or workflow_dispatch job) that probes `GET /auth/me`, `GET /billing/status` (expect
  `configured:true`), Google OAuth start redirect, magic-link send, and a Stripe test-mode checkout
  round-trip, printing a go/no-go checklist. Why now: live probe today shows `/billing/status`
  `configured:false` while price IDs are already in `wrangler.toml` — issue #20's checklist is
  half-done with no verifiable finish line; a smoke script turns the owner's secret-setting session
  into a 5-minute verified cutover.
- **Reconcile live-search overlay rows against the official House index (data-quality job)
  (CODEX, M)** — Nightly/admin job that re-checks recent `pollHouseLiveSearch()`-sourced
  transactions against the next-day official House disclosure index, flagging missed, mutated, or
  orphaned filings into the existing DLQ/diagnostics surface. Why now: PR #160 just verified the
  intraday overlay path works as coded — the natural next hardening is verifying its OUTPUT stays
  consistent with the authoritative source, since intraday scrapes are the highest-drift ingestion
  surface and premium subscribers will be paying for exactly this data.
- **Adopt the docs/rollouts/ note convention in Congress.Trade AGENTS.md (CLAUDE, S)** — Add the
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

## Changelog of this log
- 2026-07-05 — CLAUDE next-wave (cycle 2): stale-row corrections (tokenless-dep switch and
  house-live-search moved to Completed; #139 docs-convention parenthetical amended; Deployed
  section corrected to record 3 failed-health-gate deploys; mirror-staleness and STATUS.md
  staleness flagged) + 9 new Planned rows added under "2026-07-05 next-wave (cycle 2)".
- 2026-07-05 — CURSOR: completed all 6 assigned backlog tasks + tokenless git dep fix; moved from Planned → Completed.
- 2026-07-04 — bootstrapped by CODEX for the all-app coordination protocol.
- 2026-07-04 — CLAUDE: backlog exhaustiveness + assignment pass (owner-directed); seeded the
  Planned section from a full repo audit. Issues-mirror bootstrap (sync script + workflow +
  populated repo mirror) in flight on a CLAUDE branch, building on Codex PR #137.
