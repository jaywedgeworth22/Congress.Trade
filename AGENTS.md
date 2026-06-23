# Agent Handoff Rules

This repo is worked by multiple agents. Read this before editing.

## Current Shape

- The runnable app is in `app/`, not the repository root.
- `app/wrangler.toml` targets the real `congress.trade` Worker, custom domains,
  D1 database, KV namespace, R2 bucket, and queues.
- Root files are supporting context:
  - `congress-trade-feed-design.md` is historical design/product context.
  - `congress_trade_watch.py` is a standalone local House PTR watcher prototype.
  - `dashboard-design.html` is a historical/static design artifact.
- Current app surfaces include ingestion, extraction, normalization, delivery,
  admin, auth, billing, analytics, enrichment, prices, backfill, and UI.

## Branch And Worktree Policy

- Create or switch to a separate branch before non-trivial edits.
- Codex branches: `codex/<short-topic>`.
- Claude branches: `claude/<short-topic>`.
- Shared feature branches are acceptable when explicitly coordinated.
- Do not edit another agent's branch unless asked.
- Do not push, deploy, apply remote migrations, or run production scripts unless
  the user explicitly asks.

Before editing, run:

```bash
git status --short --branch
git worktree list
gh pr list --state open
```

If another branch or PR is touching the same files, either choose a disjoint
slice or stop and report the overlap.

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

## Environment Rules

- Local secrets go in `app/.dev.vars`, copied from `app/.dev.vars.example`.
- Never commit `.dev.vars`, real API keys, tokens, or generated local state.
- Production secrets are set with `wrangler secret put`.
- The admin API fails closed unless `ADMIN_TOKEN` or Cloudflare Access is
  configured. `ADMIN_OPEN_IN_DEV=true` is only for local development.

## Migrations

D1 migrations do not automatically run just because code deploys. If you add or
change a migration:

- Add the SQL file under `app/migrations/`.
- Keep `POST /api/admin/migrate` in `app/src/admin/routes.ts` in sync when the
  migration is safe to run idempotently through the Worker binding.
- Document whether production should use `npm run migrate:remote`,
  `npm run deploy:full`, or `scripts/ship.sh`.

## Open Decisions To Preserve

- Subscription CRUD is currently public and returns operational subscription
  objects. Before tightening it, decide the client ownership/auth model and
  whether webhook secrets should be returned only once on creation.
- Transaction persistence needs a durable row identity policy for at-least-once
  queue retries. Decide between deterministic transaction IDs or a unique
  `(doc_id, row_key)` schema before changing existing data.
- Analytics routes are public today. If analytics should become premium-only,
  add entitlement middleware and update UI/tests/docs together.
- `main` has no branch protection/ruleset at the time of this audit. Prefer PRs
  with CI required before merges.

## Verification Standard

For most code changes:

```bash
cd app
npm run typecheck
npm test
```

For deployment/config changes, also inspect `app/wrangler.toml`, relevant docs,
and whether migrations need to be applied separately.
