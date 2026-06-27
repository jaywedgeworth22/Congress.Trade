# Congress.Trade

Congress.Trade is a Cloudflare Workers app that ingests US congressional STOCK
Act trade disclosures, stores normalized transactions in D1, serves a public
dashboard and APIs, and supports admin, auth, billing, enrichment, backfill,
webhook, and SSE workflows.

## Repository Layout

| Path | Purpose |
|------|---------|
| `app/` | The production Worker app. Run almost all commands from here. |
| `app/src/` | TypeScript source for ingestion, extraction, delivery, admin, auth, billing, analytics, enrichment, prices, and UI. |
| `app/migrations/` | D1 schema migrations. Production migrations are not automatic. |
| `app/docs/` | Runbooks for auth/billing and cross-app FMP data sharing. |
| `app/scripts/` | Operational scripts. Some target production, so read headers before running. |
| `congress-trade-feed-design.md` | Historical design context and product rationale. |
| `congress_trade_watch.py` | Standalone local House PTR watcher prototype. It is not the production ingest path. |
| `dashboard-design.html` | Historical/static UI design artifact. Current UI lives in `app/src/ui/`. |
| `AGENTS.md` | Collaboration rules for Codex, Claude, and other agents. |
| `CLAUDE.md` | Claude entrypoint that points to the same rules. |
| `STATUS.md` | Current integration snapshot and handoff checklist. |

## Daily Development

```bash
cd app
npm ci
npm run typecheck
npm test
npm run dev
```

The default `npm run deploy` uses `app/wrangler.toml`, which currently points at
the `congress-trade` Worker, the real `congress.trade` custom domains, and
production Cloudflare resources. The preview Worker is `congress-trade-preview`.
Do not deploy or run production scripts unless that is explicitly intended.

## Coordination

Use a separate branch for every non-trivial change. Codex branches should use
`codex/`, Claude branches should use `claude/`, and feature branches should be
descriptive. Before editing, check:

```bash
git status --short --branch
git worktree list
gh pr list --state open
```

See `AGENTS.md` for the full handoff and verification rules.
