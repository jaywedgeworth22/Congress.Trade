# Current Handoff

Last updated: 2026-06-23

This repo is worked by multiple agents. `AGENTS.md` is the policy source of
truth; this file is the short operational snapshot for the current integration.

## Active Integration

- Integration branch: `codex/audit-app-structure-and-docs`.
- Integration PR: `#29` after push.
- Claude PRs integrated here: `#26` (`claude/transactions-from-filter`), `#27`
  (`claude/sse-backlog`), and `#28` (`feat/managed-payments`).
- After `#29` lands, treat `#26`, `#27`, and `#28` as superseded unless GitHub
  already marks them merged.

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

## Required Verification

Run from `app/` before merging:

```bash
npm run typecheck
npm test
```

If deploying a build that includes migration `0008`, apply migrations before or
with deploy:

```bash
npx wrangler d1 migrations apply DB --remote
```

or use the secured admin migration endpoint documented in `app/DEPLOY.md`.

## Branch Policy

`main` should stay protected: PR required, `typecheck + test` required, stale
reviews dismissed, force pushes disabled, deletions disabled. Agents should not
direct-push or deploy unless Jay explicitly asks.
