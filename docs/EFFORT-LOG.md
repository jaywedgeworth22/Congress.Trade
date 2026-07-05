# Congress.Trade Effort Log — cross-agent board
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board:
`/Users/jay/apps/CONGRESS-TRADE-EFFORT-LOG.md` (mirror: this file). As of 2026-07-04.

## Deployed
- (record production Worker releases here after explicit owner-approved deploys)

## Completed
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
  `docs/EFFORT-LOG.md`/rollout-notes convention in this repo's `AGENTS.md` today). Post-merge
  note: `Shared package pin check` briefly showed FAILURE on `main` right after this merged —
  transient, since Socratic.Trade's own pin hadn't switched yet at that instant; not a required
  check and self-corrected once Socratic.Trade#439 merged.
- **PR #137 (`codex/agent-coordination-bootstrap`, Codex) — MERGED 2026-07-04.** Docs-only
  bootstrap: added the standard cross-agent coordination stanza to `AGENTS.md` and seeded a
  near-empty repo-tracked `docs/EFFORT-LOG.md` (this file, later populated by the issues-mirror
  bootstrap below). No app-runtime code changes; no preview or production deploy.

## In Progress
- Shared-dep tokenless git-dependency switch (CLAUDE, cross-app — see TRADING board row; sync-26).

## Planned / Reserved

_2026-07-04 backlog exhaustiveness pass (CLAUDE, owner-directed). Tags: CURSOR = Cursor background
agents (DeepSeek v4 Pro), CODEX = Codex, AG = Antigravity/Gemini, CLAUDE = Claude Code. Assignments
are reservations, not locks — re-negotiate in #agent-sync._

- **Wire the live/intraday House search path (CODEX, M)** — `pollHouseLiveSearch()` TODO in
  `app/src/ingestion/houseSource.ts`; only the daily/backfill path exists today.
- **Acquisition-vs-rename guard for ticker aliases (AG, M, cross-app)** — `app/src/export/pitScores.ts`
  + `app/src/extraction/normalizer.ts` consume the flat shared `TICKER_ALIASES` (ATVI→MSFT
  undifferentiated from true renames), the same bug class fixed consumer-side in Socratic.Trade#291;
  pairs with the shared-package split row on the congress-trading-shared board.
- **Congress push/SSE contract repair (AG, M, cross-app)** — App A pushes a shape App B never
  accepts, so the push path is dead; paired row on the Socratic.Trade board.
- **Fix `shared-package-pin-check.yml` PEER_REPO (CURSOR, S)** — still points at the renamed
  `agentic-trading`; update to `Socratic.Trade` and verify the peer fetch actually resolves in a
  live run.
- **Port pin-check hardening from the peer repo's copy (CURSOR, S)** — compare exact
  pins/lockfile-resolved versions (not range-stripped lower bounds); hard-fail when the peer
  dependency key is missing instead of warn-and-exit-0.
- **Prune leftover `packages: read` permissions (CURSOR, S)** — ci.yml/deploy.yml/deploy-staging.yml
  no longer touch GitHub Packages after PR #139.
- **ESLint bootstrap + unused-code compiler flags (CURSOR, M)** — no linter exists; also enable
  `noUnusedLocals`/`noUnusedParameters`.
- **`vitest.config.ts` + coverage reporting (CURSOR, S)** — tests run on defaults; no coverage
  visibility across 219 test files.
- **Confirm or remove `app/tsconfig.ingestcheck.json` (CURSOR, S)** — nothing appears to invoke it.
- **Sentry CI failure reporter (CLAUDE, S)** — copy the additive `sentry-ci-report.yml` fleet
  standard from Socratic.Trade per AGENT-SYNC.md observability rules.
- **Promote shared-package-pin-check to a required check (unassigned, S)** — deferred in the
  workflow's own header until shared-pkg bumps always land as matched pairs.
- **Owner decision: should public subscription creation require login? (unassigned, M)** —
  AGENTS.md "Open Decisions To Preserve".
- **Owner decision: should analytics routes become premium-only? (unassigned, M)** — AGENTS.md
  "Open Decisions To Preserve".
- **Wave 4 go-live: configure auth + Stripe paywall services (unassigned, M)** — board reservation
  for hand-made issue #20, which stays canonical.

## Changelog of this log
- 2026-07-04 — bootstrapped by CODEX for the all-app coordination protocol.
- 2026-07-04 — CLAUDE: backlog exhaustiveness + assignment pass (owner-directed); seeded the
  Planned section from a full repo audit. Issues-mirror bootstrap (sync script + workflow +
  populated repo mirror) landed on this branch, building on Codex PR #137. Moved PR #137 itself
  to Completed now that it merged.
