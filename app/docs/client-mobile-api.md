# Client Mobile API Coordination

Last updated: 2026-06-23

This is the working coordination note for the phone-first Next.js/PWA and the
SwiftUI iPhone app. Keep it aligned with `app/docs/mobile-app-roadmap.md` and
the implementation mounted at `/api/client/v1/*`.

## Source Of Truth

- The Cloudflare Worker backend owns data access, calculations, entitlement,
  billing state, scraping, extraction, enrichment, prices, delivery, backfills,
  provider secrets, admin tokens, and MCP/tool orchestration.
- Next.js/PWA and SwiftUI are peer clients over the same backend-owned API.
- Do not add client-only scraping, calculation, provider-secret, admin, MCP, or
  migration paths.

## Shared Contract

- Use `/api/client/v1/*` for app-facing DTOs instead of binding mobile clients
  to internal web, admin, ingestion, or provider routes.
- Keep TypeScript DTOs and Swift `Codable` models equivalent.
- Preserve one auth/session model across clients: secure HTTP-only cookies for
  the PWA, Keychain refresh sessions for iOS, and backend token validation.
- Account alerts and developer delivery settings should be account-owned
  resources, not bearer-secret-only objects in mobile UI.

## Command And Status Model

Every client mutation should go through a backend command:

- `POST /api/client/v1/commands` with `{ type, payload, idempotencyKey }`.
- `GET /api/client/v1/commands/:id` for status, validation errors, audit trail,
  and resulting resource IDs.
- Optional foreground status streaming can use
  `GET /api/client/v1/commands/stream` when supported.

Use the shared statuses:

- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`

Command writes must validate account ownership and entitlement before queueing,
be idempotent by `requestedBy + idempotencyKey`, and leave an audit trail.

## Initial Surface

- Implemented now: bootstrap, `me`, feed, preferences, subscription listing,
  and command-backed preference/subscription create/update.
- Next: trade detail, ticker detail, member detail, analytics summary, alert
  create/update/pause commands, device registration for APNs and web push,
  rotate secret, test delivery, and delivery history.

## Production Boundaries

- Mobile/PWA work must not require production deploys, remote D1 migrations,
  queue drains, production crawlers, or backfills unless Jay explicitly asks.
- If a contract change needs a migration or production backfill, document that
  in the PR and keep the code path safe before the production step runs.
