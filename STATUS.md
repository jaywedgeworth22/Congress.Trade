# Current Handoff

Last updated: 2026-06-23

This repo is worked by multiple agents. `AGENTS.md` is the policy source of
truth; this file is the short operational snapshot for the current integration.

## Active Integration

- Main already includes integration PR `#29`, which superseded Claude PRs `#26`
  (`claude/transactions-from-filter`), `#27` (`claude/sse-backlog`), and `#28`
  (`feat/managed-payments`).
- Current Codex branch: `codex/production-mobile-readiness`.
- Current scope: mobile dashboard polish, shared Next.js/PWA + SwiftUI client
  roadmap, and production-readiness follow-up.

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
  and SwiftUI iPhone app must share one backend `/api/client/*` contract and one
  server-side command/status model.

## Production Follow-Up

- Public reads at `congress.trade` are live.
- Public subscription listing is closed in production.
- Remote D1 migration application was attempted on 2026-06-23 but blocked by
  Cloudflare authorization for the configured account. Apply migration `0008`
  before relying on live primary ingestion idempotency.

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
