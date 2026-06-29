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

Client mutations go through a backend command when the route supports it:

- `POST /api/client/v1/commands` with `{ type, payload, idempotencyKey }`.
- `GET /api/client/v1/commands/:id` for status, validation errors, audit trail,
  and resulting resource IDs.
- `GET /api/client/v1/commands/stream` is not implemented yet; clients should
  poll `GET /api/client/v1/commands/:id`.

Use the shared statuses:

- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`

Command writes must validate account ownership and entitlement before queueing,
be idempotent by authenticated `userId + idempotencyKey`, and leave an audit
trail.
The current router implements `update_preferences`, `create_subscription`, and
`update_subscription`; `start_checkout` and `request_export` are defined in the
shared type set but still return `501`.

## Initial Surface

- Implemented now: bootstrap, `me`, feed, `preferences` GET/PUT, subscription
  listing, and command-backed preference/subscription create/update.
- `bootstrap` currently returns `serverTime`, `auth`, `capabilities`, and an
  `endpoints` map for the current client surface.
- `feed` currently accepts query params like `since`, `ticker`, `member`,
  `chamber`, `type`, `from`, `to`, `order`, and `limit`, and returns the
  cursor/count/total metadata used by polling clients.
- Each feed item's `asset` object carries `name` (the disclosed asset text),
  `ticker`, raw disclosure `type`, `typeName`, canonical cross-chamber
  `typeCategory` / `typeCategoryLabel`, `sector`, and `marketCapBucket`, plus
  two enrichment fields shared with the web client so every surface renders
  identically:
  - `companyName` — the canonical company name from `securities_ref`
    (`null` until the ticker is enriched).
  - `logoUrl` — a same-origin path to the cached logo proxy, e.g.
    `/api/logos/ticker?symbol=AAPL` (`null` when no ticker resolves). Clients
    render `<img>` against this URL directly; the proxy handles the logo
    provider key and edge caching server-side and 404s on a true miss so the
    client can fall back to a monogram.
- Next: trade detail, ticker detail, member detail, analytics summary, alert
  create/update/pause commands, device registration for APNs and web push,
  rotate secret, test delivery, delivery history, and foreground command
  streaming.

## Production Boundaries

- Mobile/PWA work must not require production deploys, remote D1 migrations,
  queue drains, production crawlers, or backfills unless Jay explicitly asks.
- If a contract change needs a migration or production backfill, document that
  in the PR and keep the code path safe before the production step runs.
