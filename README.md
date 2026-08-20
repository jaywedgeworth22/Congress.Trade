# Congress.Trade

Congress.Trade is a live product at [congress.trade](https://congress.trade)
that ingests public US STOCK Act trade disclosures (House, Senate, and
Executive Branch OGE 278-T), extracts and normalizes trades, and serves a
public dashboard plus REST, webhook, and SSE delivery.

Production is not a Cloudflare Worker.  The runnable app lives in `app/` and
runs as a Deno process inside the Coolify `congress-app` Docker container on
the Hetzner host `fleet-hetzner-nbg1`.  Structured data is a host SQLite file
at `/data/congress-trade/db.sqlite`.  Filing PDFs live in Cloudflare R2.
Cloudflare is used for DNS and the edge in front of the host; it is not the
application runtime.

## Repository Layout

| Path | Purpose |
|------|---------|
| `app/` | The production app (Deno / Hono).  Run almost all commands from here. |
| `app/src/` | TypeScript source for ingestion, extraction, delivery, admin, auth, billing, analytics, enrichment, prices, and UI. |
| `app/src/deno/main.ts` | Production entrypoint.  `app/Dockerfile` caches and runs this file. |
| `app/docker-compose.yml` | Coolify compose project: `congress-app`, `sqlite-web`, `scan-cpu-worker`. |
| `app/migrations/` | Local schema files.  Production schema is applied via `POST /api/admin/migrate`, not Wrangler D1. |
| `app/docs/` | Runbooks for auth/billing, preview leftovers, and cross-app FMP data sharing. |
| `app/scripts/` | Operational scripts.  Some target production, so read headers before running. |
| `congress-trade-feed-design.md` | Historical design context and product rationale. |
| `congress_trade_watch.py` | Standalone local House PTR watcher prototype.  It is not the production ingest path. |
| `dashboard-design.html` | Historical/static UI design artifact.  Current UI lives in `app/src/ui/`. |
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

Pushes to `main` are built by Coolify from `app/docker-compose.yml`.  The
`npm run deploy` script does not publish a Worker; it only reminds you that
Coolify owns production.  After a `main` deploy, apply schema with
`ADMIN_TOKEN=... bash app/scripts/ship.sh` (waits for the live `/api/health`
build SHA, then `POST /api/admin/migrate` against `https://congress.trade`).

There is no production `app/wrangler.toml`.  `app/scripts/deploy-preview.sh`
is leftover isolated Wrangler preview tooling and is not the live site.  Do
not deploy, migrate production, or run ingest/backfill unless that is
explicitly intended.

## Coordination

Use a separate branch for every non-trivial change.  Codex branches should use
`codex/`, Claude branches should use `claude/`, Cursor branches should use
`cursor/`, Copilot branches should use `copilot/`, and Antigravity branches
should use `antigravity/`.  Shared feature or integration branches should be
explicit and descriptive.  Before editing, check:

```bash
git status --short --branch
git worktree list
gh pr list --state open
```

See `AGENTS.md` for the full handoff and verification rules.
