# Current Handoff

Last updated: 2026-06-30

This repo is worked by multiple agents. `AGENTS.md` is the policy source of
truth; this file is the short operational snapshot for the current integration.

## Active Integration

- Main already includes integration PR `#29`, which superseded Claude PRs `#26`
  (`claude/transactions-from-filter`), `#27` (`claude/sse-backlog`), and `#28`
  (`feat/managed-payments`).
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
