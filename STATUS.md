# Current Handoff

Last updated: 2026-07-11

This repo is worked by multiple agents. `AGENTS.md` is the policy source of
truth; this file is the short operational snapshot for the current integration.

## 2026-07-11 — Whole-App Hardening Integration

- PR #284 merged the completed backend reliability, billing/security, PWA, and
  iOS audit follow-through to `main` as `8a855cb`. Independent semantic and
  schema reviews pass.
- Isolated preview Worker version `85417928-cae4-4bb6-8706-96c739846533` is
  healthy at `https://congress-trade-preview.jaywedgeworth22.workers.dev` with
  `ok=true`, `db=true`, and `schema=true`. A legacy preview-only missing
  transaction row-key index was detected by readiness and repaired after
  duplicate-key verification.
- Final app gate: typecheck; 95 files / 808 tests; coverage
  67.90/60.14/71.91/70.15; lint 0 errors; npm audit 0; fresh 28-migration D1;
  production and preview Wrangler dry-runs.
- Final client gate: PWA typecheck, 3 files / 13 tests, production build, audit
  0, desktop/mobile rendered QA; iOS generic Simulator build and
  build-for-testing. XCTest execution still needs an installed concrete
  Simulator runtime.
- State boundaries: PR #284 merged as `8a855cb`; production Worker
  `d1dcd17f-8724-40db-9980-6d4f7f6f88e3` is live with schema-aware readiness
  green. No ingestion, queue drain, backfill, or billing activation ran. PWA and
  iOS source is on `main`, but neither prototype has a configured standalone
  production host/App Store release target.

## 2026-07-05 (Antigravity) — Shared Ticker Alias Logic and SSE Client

Owner-directed: Migrated ticker normalization and point-in-time score builders to use the centralized `resolveContinuousTicker` and `TICKER_RENAMES` from `congress-trading-shared`. This fixes the "Acquisition-vs-rename guard" issue where acquisitions like ATVI->MSFT were grouped indistinguishably from true renames (e.g., FB->META). We now ensure acquisitions are point-in-time correct and uncollapsed. Also prepared the repo to use the shared typed `CongressTradeClient` for SSE subscriptions.

- Tested locally and typechecked successfully.
- Code modified in `app/src/extraction/normalizer.ts`, `app/src/extraction/tickerNormalize.ts`, `app/src/export/pitScores.ts`, and their tests.

## 2026-07-05 (Antigravity) — Senate Scraper KV Caching

Owner-directed: Added Cloudflare KV session caching for the Senate eFD scraper. The scraper logic now caches the session CSRF token and cookies to reduce the frequency of agreement gate handshakes, making ingestion more reliable and less likely to be throttled or blocked. A 24h TTL is set for the cache, with automatic invalidation and retry upon any 403 or parse error from the Senate site.

- Tested locally and typechecked successfully.
- Code added in `app/src/ingestion/senateSource.ts` and `app/src/ingestion/watcher.ts`.

## 2026-07-04 — Tokenless git dependency for congress-trading-shared (Claude)

Owner-directed: `congress-trading-shared` (this repo's App B/App A shared
contract package) was made **public**, so `app/package.json`'s dependency spec
switched from the private GitHub Packages registry (`^1.2.0` against
`npm.pkg.github.com`, requiring `NODE_AUTH_TOKEN`/`GH_PACKAGES_TOKEN` in every
CI job) to a **tokenless git dependency**:
`github:jaywedgeworth22/congress-trading-shared#semver:^1.2.x`. That range
resolves against the shared repo's new `v1.2.0` tag (first tag in that repo).

- Removed `app/.npmrc` (only had the now-unneeded scoped-registry line).
- Removed the "Configure GitHub Packages" step (`NODE_AUTH_TOKEN` +
  `npm.pkg.github.com` `.npmrc` write + stale `npm view ...@1.0.0` sanity
  check) from `.github/workflows/ci.yml`, `deploy.yml`, `deploy-staging.yml`;
  dropped the now-unused `packages: read` permission from each.
- `.github/workflows/shared-package-pin-check.yml` still needs
  `GH_PACKAGES_TOKEN`, but only to read the peer app repo's `package.json` via
  the GitHub API (that repo is still private) — unrelated to npm registry
  auth. Updated its version-comparison logic to also handle a
  `github:...#<ref>` git-dep spec (extract the ref after `#`) instead of only
  bare semver ranges.
- Regenerated `app/package-lock.json` with a clean, fully tokenless
  `npm install` (no `NODE_AUTH_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN` set). Verified
  `npm ci` also succeeds with `GIT_SSH_COMMAND=false` (forces SSH to fail) —
  npm falls back to anonymous HTTPS for this public repo, so no SSH key is
  needed in CI.
- Verify: `npm run typecheck` clean; `npm test` — 77 files / 669 tests passed.

See `/Users/jay/apps/CONGRESS-TRADE-EFFORT-LOG.md` for the cross-repo effort
entry (2026-07-05 (CLAUDE next-wave): this repo now DOES have a
`docs/EFFORT-LOG.md` mirror and `AGENTS.md` mandates it — added via #137/#141
— so only the rollout-notes half of the original claim below is still true:
this repo has no `docs/rollouts/` convention yet, so this STATUS.md entry
remains the paper trail for that part).

## Active Integration

2026-07-05 (CLAUDE next-wave) correction: this section was dated 2026-07-04 and
stale — the Codex house-live-search lane below has since MERGED (PR #160,
`3e2d622c`, 2026-07-05), and it omitted the effort-issues-sync work (#141/#162)
and the red Deploy/Uptime pipelines (see the live board's Deployed-section
correction: 3 deploys 6/30-7/3 failed the health gate on a Cloudflare managed
challenge, so `POST /api/admin/migrate` never ran). Refreshing below:

- Main already includes integration PR `#29`, which superseded Claude PRs `#26`
  (`claude/transactions-from-filter`), `#27` (`claude/sse-backlog`), and `#28`
  (`feat/managed-payments`).
- `codex/house-live-search` MERGED 2026-07-05 (PR #160, merge `3e2d622c`): the
  House intraday watcher/live-search overlay was already implemented on
  `main`; that branch added focused `pollHouseLiveSearch()` + watcher-behavior
  coverage and removed stale "TODO/stub" wording in docs. Preview deployed and
  health-checked; production deploy still needs explicit owner approval and is
  currently blocked by the Cloudflare health-gate issue above.
- `claude/agent-coordination + effort-issues-sync` (PRs #137, #141, #162) MERGED:
  the GitHub Issues mirror of the effort board, plus secondary-rate-limit
  hardening for the sync script, are live on `main`.
- **Known blocker:** the Deploy workflow's health check 403s on a Cloudflare
  managed challenge from GitHub-runner IPs (affected the 6/30, 7/2, 7/3 runs);
  see the live board's new Planned row for the fix. Uptime Monitor is also
  currently crashing (bad heredoc delimiter on challenge-page HTML) rather than
  reporting real uptime.
- Current ops/deploy hardening branch: `codex/app-update-hardening-20260629`.
- Active app work may be happening on separate Codex, Claude, Cursor, Copilot,
  Antigravity, or other coordinated branches. Before editing, run the AGENTS.md
  preflight commands and inspect open PR changed files/checks for overlap.
- Current product direction: mobile dashboard polish plus a phone-first
  Next.js/PWA and SwiftUI iPhone app that share one backend-owned
  `/api/client/v1/*` contract and command/status model.

## Decisions Now Implemented

- Admin routes fail closed unless `ADMIN_TOKEN`, Cloudflare Access, or explicit
  local `ADMIN_OPEN_IN_DEV=true` is configured.
- Public subscription listing is closed. Public create returns a generated
  secret once; get/patch/SSE require that secret.
- Live transaction persistence uses stable `row_key` values and migration
  `0008_idempotency_keys.sql`.
- Webhook delivery claims a unique `(subscription_id, tx_id)` row before POSTing.
- Stripe Managed Payments support is present but off by default through
  `STRIPE_MANAGED_PAYMENTS = "false"`.
- Backend is the source of truth for future clients. The phone-first Next.js/PWA
  and SwiftUI iPhone app now start from one backend `/api/client/v1/*` contract
  and one server-side command/status model.
- Migration `0009_client_api.sql` adds `user_preferences` and
  `client_commands` for the shared PWA/Swift command gateway.
- Client apps must not own scraping, calculations, provider credentials, admin
  tokens, migrations, backfills, billing secrets, or MCP/tool orchestration.
- Client writes should flow through server-side commands with idempotency,
  account ownership, entitlement checks, audit trail, and pollable/streamable
  status.

## Production Follow-Up

- Public reads at `congress.trade` are live.
- Public subscription listing is closed in production.
- Production schema is applied through `POST /api/admin/migrate` via
  `app/scripts/ship.sh`. Do not use or reconcile the remote Wrangler D1
  migration log; it intentionally lags the real schema.

## Required Verification

Run from `app/` before merging:

```bash
npm run typecheck
npm test
```

If deploying a build with schema changes, mirror the SQL under `app/migrations/`
in the idempotent admin migrate list, then use the guarded deploy path:

```bash
ADMIN_TOKEN=... bash scripts/ship.sh
```

`ship.sh` deploys, checks `GET /api/health`, then calls
`POST /api/admin/migrate`. Without `ADMIN_TOKEN`, it fails before deploying
unless `--deploy-only` is explicitly passed. Never run
`wrangler d1 migrations apply DB --remote` for production on this account.

Do not run deploys, remote migrations, production backfills, queue drains, or
production ingestion jobs unless Jay explicitly asks for production action.

## Branch Policy

`main` should stay protected: PR required, `typecheck + test` required, stale
reviews dismissed, force pushes disabled, deletions disabled. Agents should not
direct-push or deploy unless Jay explicitly asks.

Use separate branches for separate agents: `codex/`, `claude/`, `cursor/`,
`copilot/`, or `antigravity/` unless explicitly coordinated otherwise. If
another branch or PR is touching the same files, either pick a disjoint slice,
ask Jay which branch owns the work, or create a deliberate integration branch.
