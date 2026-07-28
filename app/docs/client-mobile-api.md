# Client Mobile API Coordination

Last updated: 2026-07-19

This is the working coordination note for the phone-first SwiftUI and the
SwiftUI iPhone app. Keep it aligned with `app/docs/mobile-app-roadmap.md` and
the implementation mounted at `/api/client/v1/*`.

## Source Of Truth

- The Cloudflare Worker backend owns data access, calculations, entitlement,
  billing state, scraping, extraction, enrichment, prices, delivery, backfills,
  provider secrets, admin tokens, and MCP/tool orchestration.
- SwiftUI are peer clients over the same backend-owned API.
- Do not add client-only scraping, calculation, provider-secret, admin, MCP, or
  migration paths.

## Shared Contract

- Use `/api/client/v1/*` for app-facing DTOs instead of binding mobile clients
  to internal web, admin, ingestion, or provider routes.
- Keep TypeScript DTOs and Swift `Codable` models equivalent.
- Preserve one auth/session model across clients: secure HTTP-only cookies for
  Keychain refresh sessions for iOS, and backend token validation.
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

- Implemented now: bootstrap, `me`, feed, trade detail, ticker detail,
  politician detail (`member` endpoint), `preferences` GET/PUT, subscription listing, and command-backed
  preference/subscription create/update.
- `bootstrap` currently returns `serverTime`, `auth`, `capabilities`, and an
  `endpoints` map for the current client surface.
- `feed` currently accepts query params like `since`, `ticker`, `member`,
  `chamber`, `type`, `from`, `to`, `order`, and `limit`, and returns the
  cursor/count/total metadata used by polling clients.
- Chamber filter: `chamber` accepts a CSV multi-selection over
  `house`, `senate`, and `executive` (Presidential trades from OGE Form 278-T
  filings; `member.chamber` can now be `executive`). ABSENT `chamber` means the
  default congressional view — executive rows are EXCLUDED unless explicitly
  requested, so a single multi-thousand-row presidential filing never swamps
  default feeds, analytics, or alert deliveries. Clients that want executive
  trades must opt in (e.g. `chamber=house,senate,executive`).
- Anti-scrape guard (`SCRAPE_GUARD_ENABLED`, `src/security/botDefense.ts`):
  `feed` AND the detail reads below (`trade/:id`, `ticker/:ticker`,
  `member/:memberIdOrName`) share one per-IP daily served-row budget with
  `/api/transactions` and can return `429` with `Retry-After` when a caller
  bulk-walks the corpus. Normal client polling (`since`-cursor, mostly zero new
  rows) does not meaningfully consume the budget; clients should honor
  `Retry-After` and back off. Public data endpoints also reject known
  scraper/AI-crawler user agents with `403` — real browser, `EventSource`, and
  iOS `CFNetwork`/`URLSession` agents are unaffected.
- Zero-delta poll responses omit aggregates: when `feed` is called with a
  `since` cursor and it yields zero new rows (the client's steady state), the
  response omits `total` (and, on `/api/transactions`, `filingsImportedToday`)
  instead of recomputing them — full-corpus `COUNT(*)` scans on every idle
  poll are not worth the D1 read cost when nothing changed. This mirrors what
  both known clients already do (they gate every read of `total`/`cursor`
  behind "did I get any new rows back?" and no-op otherwise): treat an
  absent/non-numeric `total` on a `since`-poll response as "unchanged from
  your last known value," never as `0`.
- Public detail reads use the same `ClientTrade` item DTO and feed-style
  envelope metadata:
  - `GET /api/client/v1/trade/:id`
  - `GET /api/client/v1/ticker/:ticker`
  - `GET /api/client/v1/member/:memberIdOrName`
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
- Each feed item's `transaction.type` (`P`/`S`/`E`) can be `null` for a filing
  row whose disclosed side didn't parse (malformed/partial source text). This
  is an honest passthrough, not a silent default to `P` (Purchase): a
  transaction with no confirmed side must not be misreported as a buy. Ticker
  and member summary aggregates (`buyCount`/`sellCount`/`exchangeCount`,
  `estimatedNetFlowUsd`) already exclude a non-matching/`null` `tx_type` from
  every bucket rather than counting it as one; alert-subscription `sides`
  filters behave the same way. Clients should render a `null` type as
  "unknown"/omit the buy-sell badge rather than assuming Purchase.
- Command idempotency is race-safe end to end: a concurrent duplicate
  `POST /api/client/v1/commands` with the same `idempotencyKey` never 500s —
  it replays the winning row (`replayed: true`, `200`) or, in the rare case the
  winner's row can't be found on re-fetch, returns `409`. A `queued`/`running`
  command whose owning request died mid-flight (crash/eviction, never reached
  a terminal status) is NOT replayed forever: once it's sat in that state
  past `STALE_IN_FLIGHT_COMMAND_TTL_MS` (2 minutes; see `state.ts`), the next
  request with the same idempotency key reclaims and re-runs the same row
  instead of returning a status that can never change.
- Next: analytics summary, alert create/update/pause commands, device
  registration for APNs and web push, rotate secret, test delivery, delivery
  history, and foreground command streaming.

## Production Boundaries

- Mobile/web app work must not require production deploys, remote D1 migrations,
  queue drains, production crawlers, or backfills unless Jay explicitly asks.
- If a contract change needs a migration or production backfill, document that
  in the PR and keep the code path safe before the production step runs.
