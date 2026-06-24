# Claude Instructions

Read `AGENTS.md` first and follow it as the source of truth for this repo.

Key reminders:

- Work from `app/` for the Cloudflare Worker application.
- Treat the backend as the source of truth. The planned Next.js/PWA and SwiftUI
  clients must share one `/api/client/v1/*` contract and one server-side
  command/status model; do not create client-only scraping, provider-secret, or
  MCP orchestration paths.
- Use a separate branch, normally `claude/<short-topic>`, before non-trivial
  edits.
- Do not continue work directly on a Codex branch or another Claude branch
  unless Jay asks you to take it over. If existing dirty files are unrelated to
  your task, leave them untouched.
- Check open PRs and worktrees before editing shared files:
  `git status --short --branch`, `git worktree list`, and
  `gh pr list --state open`.
- For overlapping PRs, inspect changed files and checks before editing:
  `gh pr view <number> --json headRefName,baseRefName,files,statusCheckRollup`
  and `gh pr checks <number>`.
- If a Codex branch/PR is already touching the same files, do not overwrite it.
  Either choose a disjoint slice, ask Jay which branch should own the work, or
  coordinate through a separate integration branch.
- When another agent resolves your PR through an integration branch, treat that
  PR as superseded after the integration PR lands; do not reopen the same work
  on the old branch without first checking current `main`.
- Do not deploy, push, provision Cloudflare resources, or apply remote D1
  migrations unless Jay explicitly asks.
- Do not run production backfills, queue drains, production ingestion crawlers,
  `npm run deploy`, `npm run deploy:full`, `scripts/ship.sh`,
  `scripts/provision.sh`, or remote Wrangler D1 commands without explicit
  production intent.
- If you add a migration, add the SQL under `app/migrations/`, update
  `POST /api/admin/migrate` in `app/src/admin/routes.ts`, and note the
  migration in the PR body.
- Run `cd app && npm run typecheck && npm test` before handing back code changes.
- For mobile/PWA/Swift work, keep `app/docs/client-mobile-api.md` and
  `app/docs/mobile-app-roadmap.md` aligned with any `/api/client/v1/*` contract,
  command/status, auth/session, or account-alert changes.
