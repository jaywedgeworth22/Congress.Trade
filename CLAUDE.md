# Claude Instructions

Read `AGENTS.md` first and follow it as the source of truth for this repo.

Key reminders:

- Work from `app/` for the Cloudflare Worker application.
- Use a separate branch, normally `claude/<short-topic>`, before non-trivial
  edits.
- Check open PRs and worktrees before editing shared files.
- Do not deploy, push, provision Cloudflare resources, or apply remote D1
  migrations unless Jay explicitly asks.
- Run `cd app && npm run typecheck && npm test` before handing back code changes.
