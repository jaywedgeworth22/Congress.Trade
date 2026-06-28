# Agent Handoff Rules

This repo is worked by multiple agents. Read this before editing.

## Current Shape

- The runnable app is in `app/`, not the repository root.
- `app/wrangler.toml` targets the real `congress.trade` Worker, custom domains,
  D1 database, KV namespace, R2 bucket, and queues.
- Current Cloudflare Worker service names are `congress-trade` for production
  and `congress-trade-preview` for preview. Some backing resources still use
  legacy `congress-feed-*` names; do not rename D1/R2/queues unless explicitly
  coordinating a resource migration.
- Root files are supporting context:
  - `congress-trade-feed-design.md` is historical design/product context.
  - `congress_trade_watch.py` is a standalone local House PTR watcher prototype.
  - `dashboard-design.html` is a historical/static design artifact.
- Current app surfaces include ingestion, extraction, normalization, delivery,
  admin, auth, billing, analytics, enrichment, prices, backfill, and UI.
- Planned client apps are a phone-first Next.js/PWA and a SwiftUI iPhone app.
  Both must use the same backend-owned client API and command/status model.

## Branch And Worktree Policy

- Create or switch to a separate branch before non-trivial edits.
- Codex branches: `codex/<short-topic>`.
- Claude branches: `claude/<short-topic>`.
- Shared feature branches are acceptable when explicitly coordinated.
- Do not edit another agent's branch unless asked.
- Treat a dirty worktree as owned by the agent that created those edits. Do not
  reformat, revert, stage, or "clean up" files outside your assigned slice.
- Do not push, deploy, apply remote migrations, or run production scripts unless
  the user explicitly asks.
- To resolve another agent's PR, use a separate integration branch unless the
  user explicitly asks you to take over that branch. Merge or cherry-pick the
  PR intentionally, run verification, and leave a clear PR comment/closeout.

Before editing, run:

```bash
git status --short --branch
git worktree list
gh pr list --state open
```

If another branch or PR is touching the same files, either choose a disjoint
slice, build on an integration branch that includes that work, or stop and
report the overlap.

When a PR is open, inspect its changed files and check status before starting
overlapping work:

```bash
gh pr view <number> --json headRefName,baseRefName,files,statusCheckRollup
gh pr checks <number>
```

If checks are failing, fix them on the owning branch only when explicitly asked;
otherwise coordinate through a new integration branch.

## Development Commands

Run from `app/`:

```bash
npm ci
npm run typecheck
npm test
```

Use `npm run dev` for local Wrangler development. Treat `npm run deploy`,
`npm run deploy:full`, `scripts/ship.sh`, `scripts/provision.sh`, and remote D1
commands as production-affecting until proven otherwise.

Preview deploys are the default review path after verified app changes. If
`app/wrangler.preview.toml` exists, run `cd app && npm run preview:deploy` after
`npm run typecheck` and `npm test` pass, then report the preview URL. If the
preview config is missing and the user has asked for preview behavior, run
`cd app && npm run preview:provision` once, then `npm run preview:deploy`.
Preview resources must stay isolated from production; do not use production D1,
KV, R2, queues, custom domains, cron triggers, or `app/wrangler.toml` for
preview work. Production deploys and merges still require explicit user
approval.

Backfill and ingestion commands can mutate queues, D1, KV, R2, or provider
state. Do not run remote backfills, queue drains, production crawlers, or
production ingestion jobs unless the user explicitly asks.

## Environment Rules

- Local secrets go in `app/.dev.vars`, copied from `app/.dev.vars.example`.
- Never commit `.dev.vars`, real API keys, tokens, or generated local state.
- Production secrets are set with `wrangler secret put`.
- The admin API fails closed unless `ADMIN_TOKEN` or Cloudflare Access is
  configured. `ADMIN_OPEN_IN_DEV=true` is only for local development.

## Migrations & deploy (READ THIS — the remote path is a trap)

**Production schema is applied via `POST /api/admin/migrate` (the idempotent
statement list in `app/src/admin/routes.ts`), NOT via `wrangler d1 ... --remote`.**
The wrangler remote-migration path is deliberately avoided on this account (OAuth
issues), so the remote `d1_migrations` tracking log **intentionally lags** (it sits
at an early migration while the real schema is far ahead). Running
`wrangler d1 migrations apply DB --remote` therefore tries to re-add columns that
already exist and dies with `duplicate column name: …` — this is expected, not a
bug, and it is NOT a sign that prod schema is behind. Do not "reconcile" the remote
log or force it; that fights the design.

**Canonical production deploy:** `bash app/scripts/ship.sh` — it runs `npm run deploy`
(just `wrangler deploy`, no migrations) then `POST /api/admin/migrate` (idempotent;
"duplicate column" is treated as already-applied) through the Worker's D1 binding.
`npm run deploy:full` now aliases `ship.sh`; `npm run migrate:remote` is intentionally
disabled (it errors with guidance). `npm run migrate` (`--local`) is for local dev only.

If you add or change a migration:

- Add the SQL file under `app/migrations/` (used by `npm run migrate` for LOCAL dev).
- **Mirror the same change as an idempotent statement in `POST /api/admin/migrate`**
  (`app/src/admin/routes.ts`) — that list is the source of truth for PROD schema.
- Deploy with `bash app/scripts/ship.sh`. Never `wrangler ... --remote` migrations.

## Implemented Safety Decisions

- Public subscription listing is disabled. Public creation returns the generated
  per-subscription secret once; `GET/PATCH /api/subscriptions/:id` and SSE
  streams require that secret. Admin listing is `/api/admin/subscriptions`.
- Live transaction persistence uses `transactions.row_key` plus a unique
  `(doc_id, source, row_key)` index. Retries should use `INSERT OR IGNORE` and
  enqueue delivery only for newly inserted rows.
- Webhook delivery uses a unique `(subscription_id, tx_id)` row and claims a
  pending attempt before POSTing. Recipients must still dedupe on
  `X-Subscription-Id` + `X-Tx-Id` because external webhooks are at-least-once.
- Backend remains the source of truth for all clients. Next.js/PWA and SwiftUI
  work must share one `/api/client/v1/*` contract, one auth/session model, and one
  server-side command/status gateway. Do not put scraping, calculations,
  provider secrets, admin tokens, or MCP orchestration in either client.
- The phone-first Next.js/PWA and SwiftUI iPhone app are peer clients, not
  separate products. Keep DTOs, command names, command statuses, entitlement
  behavior, and account-owned alert semantics aligned across both.
- Keep `main` protected through GitHub branch protection or a ruleset: PRs
  required, `typecheck + test` required, stale reviews dismissed, no force push
  or deletion.

## Open Decisions To Preserve

- Analytics routes are public today. If analytics should become premium-only,
  add entitlement middleware and update UI/tests/docs together.
- Decide whether public subscription creation should eventually require a signed
  in account rather than just returning a bearer secret.

## Verification Standard

For most code changes:

```bash
cd app
npm run typecheck
npm test
```

For deployment/config changes, also inspect `app/wrangler.toml`, relevant docs,
and whether migrations need to be applied separately.

## Cursor Cloud specific instructions

The VM startup update script runs `bash scripts/cloud-setup.sh` (idempotent:
`npm ci` in `app/` + applies local D1 migrations). After it runs, the dev
environment is ready; do not re-install deps to start services.

Durable, non-obvious notes for running/testing locally (all from `app/`):

- Local dev is keyless. `wrangler dev` (`npm run dev`, serves on
  `http://localhost:8787`) emulates D1/R2/KV/Queues/cron in-process — no
  Cloudflare login or API keys are needed to boot, typecheck, or test. Run it
  under tmux for long-lived sessions.
- `wrangler dev` reads vars from `app/.dev.vars` (gitignored) and `[vars]` in
  `wrangler.toml`, NOT from the OS environment. The update script merges
  known env vars into `.dev.vars`; if you add a var later, re-run
  `bash scripts/cloud-setup.sh` to merge it.
- Admin/ingest routes (`/api/admin/*`) fail closed. For local testing only, set
  `ADMIN_OPEN_IN_DEV="true"` in `app/.dev.vars` to open them.
- The cron `scheduled()` handler does NOT auto-fire in `wrangler dev`. Trigger
  it manually: `curl "http://localhost:8787/cdn-cgi/handler/scheduled"`.
- Queue consumers run inside the same `wrangler dev` process. Ingest is async:
  e.g. `POST /api/admin/backfill {"chambers":["senate"],"limit":N}` enqueues
  work; poll `GET /api/transactions` a few seconds later to see normalized rows.
  The Senate backfill default source (GitHub mirror) needs outbound network.
- Quick smoke test: `GET /api/health` returns `{"ok":true,"db":true,...}`.
