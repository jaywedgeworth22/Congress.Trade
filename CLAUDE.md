# Claude Instructions

Read `AGENTS.md` first and follow it as the source of truth for this repo.

Key reminders:

- Work from `app/` for the Cloudflare Worker application.
- Use a separate branch, normally `claude/<short-topic>`, before non-trivial
  edits.
- Check open PRs and worktrees before editing shared files:
  `git status --short --branch`, `git worktree list`, and
  `gh pr list --state open`.
- If a Codex branch/PR is already touching the same files, do not overwrite it.
  Either choose a disjoint slice, ask Jay which branch should own the work, or
  coordinate through a separate integration branch.
- When another agent resolves your PR through an integration branch, treat that
  PR as superseded after the integration PR lands; do not reopen the same work
  on the old branch without first checking current `main`.
- Do not deploy, push, provision Cloudflare resources, or apply remote D1
  migrations unless Jay explicitly asks.
- If you add a migration, add the SQL under `app/migrations/`, update
  `POST /api/admin/migrate` in `app/src/admin/routes.ts`, and note the
  migration in the PR body.
- Run `cd app && npm run typecheck && npm test` before handing back code changes.
