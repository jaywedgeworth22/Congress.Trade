# Congress.Trade

Congress.Trade is a Deno-in-Docker app (Coolify on the Hetzner fleet) that
ingests US STOCK Act disclosures (House, Senate, and Executive / OGE 278-T),
stores normalized transactions in local SQLite (Litestream-replicated), serves
a public dashboard and APIs, and supports admin, auth, billing, enrichment,
backfill, webhook, SSE, and APNs workflows.

**Deno Deploy and Turso are retired.**  Production is Coolify Docker +
`file:/data/congress-trade/db.sqlite` + Infisical.  See `AGENTS.md` "Current
Shape" and `app/DEPLOY.md`.

## Repository Layout

| Path | Purpose |
|------|---------|
| `app/` | The production Deno app (compose root for Coolify). Run almost all commands from here. |
| `app/src/` | TypeScript source for ingestion, extraction, delivery, admin, auth, billing, analytics, enrichment, prices, and UI. |
| `app/migrations/` | Local-dev schema files. Production schema is `POST /api/admin/migrate`. |
| `app/docs/` | Runbooks for auth/billing and cross-app FMP data sharing. |
| `app/scripts/` | Operational scripts. Some target production, so read headers before running. |
| `congress-trade-feed-design.md` | Historical design context and product rationale. |
| `congress_trade_watch.py` | Standalone local House PTR watcher prototype. It is not the production ingest path. |
| `dashboard-design.html` | Historical/static UI design artifact. Current UI lives in `app/src/ui/`. |
| `AGENTS.md` | Collaboration rules for Codex, Claude, Cursor, Copilot, Antigravity, and other agents. |
| `CLAUDE.md` | Claude entrypoint that points to the same rules. |
| `.cursor/rules/congress-trade.mdc` | Cursor project rule that points to the same rules. |
| `STATUS.md` | Current integration snapshot and handoff checklist. |

## Daily Development

```bash
cd app
npm ci
npm run typecheck
npm test
npm run dev
```

Production deploys via Coolify docker-compose on push to `main`.  `npm run
deploy` only prints that fact.  `bash app/scripts/ship.sh` waits for the new
SHA then runs `POST /api/admin/migrate`.  Do not `wrangler deploy`, do not
deploy to Deno Deploy, and do not point the DB at Turso.

## Coordination

Use a separate branch for every non-trivial change. Codex branches should use
`codex/`, Claude branches should use `claude/`, Cursor branches should use
`cursor/`, Copilot branches should use `copilot/`, and Antigravity branches
should use `antigravity/`. Shared feature or integration branches should be
explicit and descriptive. Before editing, check:

```bash
git status --short --branch
git worktree list
gh pr list --state open
```

See `AGENTS.md` for the full handoff and verification rules.
