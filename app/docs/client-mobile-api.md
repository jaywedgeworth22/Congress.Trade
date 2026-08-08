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
  and resulting resource IDs. Note: for `create_subscription` commands, delivery credentials (`secret`, `streamUrl`) are disclosed on the **FIRST** successful poll only. Clients MUST persist the secret upon receipt; it is claimed and unrecoverable from subsequent API reads.
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
The current router implements `update_preferences`, `create_subscription`,
`update_subscription`, `delete_subscription`, `register_device`, and
`unregister_device`; `start_checkout` and `request_export` are defined in the
shared type set but still return `501`.

### Device registration (APNs / web push)

Push tokens are **not** delivery subscriptions. They live in `push_devices` and
do not consume the SSE/webhook subscription quota.

- `POST /api/client/v1/commands` `{ type: "register_device", payload: { platform: "apns"|"webpush", token, appBundle?, env? } }`
  - Signed-in required. Not Premium-gated (store early; fan-out still Premium).
  - APNs `token` must be 64–200 hex characters.
  - Upserts on `(userId, platform, token)`; reactivates a previously deactivated row.
  - Caps at 10 active devices per user (oldest deactivated on overflow).
- `POST ...` `{ type: "unregister_device", payload: { id? } | { token, platform? } }`
- **Legacy:** older iOS builds sent `create_subscription` with `delivery: "apns"`
  and `targetUrl` = device token. The backend rewrites that to `register_device`
  so those clients stop failing with `delivery must be 'sse' or 'webhook'`.
- Actual APNs HTTP/2 trade fan-out is a follow-up (needs Apple `.p8` credentials).

## Initial Surface

- Implemented now: bootstrap, `me`, feed, trade detail, ticker detail,
  politician detail (`member` endpoint), `preferences` GET/PUT, subscription listing, and command-backed
  preference/subscription create/update.
- `bootstrap` currently returns `serverTime`, `auth`, `capabilities`, and an
  `endpoints` map for the current client surface.
- `feed` currently accepts query params like `since`, `ticker`, `member`,
  `memberName`, `chamber`, `type`, `minAmount`, `from`, `to`, `sort`, `order`,
  `offset`, and `limit`, and returns the cursor/count/total metadata used by
  polling clients. `minAmount` (server-side `filtersFromQuery`/`TxQueryParams`,
  same as the website's shared `qMinAmt`/`trMinAmt` pill) filters to
  `amountMin >= minAmount`; iOS wires it as the `$`-threshold filter pill
  (2026-08-09, iOS punch list). `GET /api/export/transactions.csv` accepts
  the same filter set (including `minAmount`) for Premium CSV export.
  - `sort` accepts `published`, `cursor` (default), or `tx_date` (fixed
    2026-08-09 — `tx_date` was already a valid `TxQueryParams`/SQL sort key
    for `/api/transactions` but this endpoint's query parser silently dropped
    it, so `?sort=tx_date` fell back to cursor order). iOS's Trades sort
    control (owner punch list #2, item 7) sends `sort=tx_date&order=asc|desc`
    for its Date option; its Amount option re-sorts the already-loaded page
    client-side only (the backend has no `amount` sort key — same pattern as
    the web dashboard's `setSort()`, which treats non-backend columns as a
    local re-sort, never a fetch beyond the loaded page).
  - `offset` (added 2026-08-09, iOS punch list #2 item 8) pages a DESC
    snapshot (pair with `order=desc`); guarded by the same
    `MAX_PUBLIC_TX_OFFSET` (2000) public depth cap as `/api/transactions` —
    a 400 past the cap points callers at Premium CSV export instead. iOS's
    "Page X of Y" pager computes total pages from the response's `total` and
    its own page-size (`limit`), independent of the forward `since`-cursor
    poll watermark, which is unaffected.
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
- `GET /api/members` (public roster, origin-level — not `/api/client/v1/*`,
  same pattern as `/api/transactions`, `auth/*`, and the logo proxy that
  `APIClient.swift` already calls at `originURL`) returns
  `{ members: [{ filerId, fullName, chamber, party, state, district, txCount,
  photoUrl }], count }`. `photoUrl` (added 2026-08-09, iOS punch list #2 item
  9) is a same-columns addition to the existing cached roster query (no new
  join, no perf regression) — `null` when the filer has no `filers.photo_url`.
  iOS's People directory tab renders it as a row avatar; the web directory
  table intentionally stays photo-less.
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
    provider key and edge caching server-side and returns 204 No Content on a
    true miss (cacheable, no console error) so the client can fall back to a
    monogram.
- Each feed item's `transaction.type` (`B`/`S`/`E`) can be `null` for a filing
  row whose disclosed side didn't parse (malformed/partial source text). This
  is an honest passthrough, not a silent default to Buy: a transaction with no
  confirmed side must not be misreported as a buy. Product labels are
  **Buy / Sell / Exchange** (storage `B`/`S`/`E`). Form text "Purchase" and
  legacy letter `P` are automatically translated to `B` on every ingest and
  API read path. Ticker and member summary aggregates
  (`buyCount`/`sellCount`/`exchangeCount`, `estimatedNetFlowUsd`) already
  exclude a non-matching/`null` `tx_type` from every bucket rather than counting
  it as one; alert-subscription `sides` filters behave the same way. Clients
  should render a `null` type as "unknown"/omit the buy-sell badge rather than
  assuming Buy.
- Command idempotency is race-safe end to end: a concurrent duplicate
  `POST /api/client/v1/commands` with the same `idempotencyKey` never 500s —
  it replays the winning row (`replayed: true`, `200`) or, in the rare case the
  winner's row can't be found on re-fetch, returns `409`. A `queued`/`running`
  command whose owning request died mid-flight (crash/eviction, never reached
  a terminal status) is NOT replayed forever: once it's sat in that state
  past `STALE_IN_FLIGHT_COMMAND_TTL_MS` (2 minutes; see `state.ts`), the next
  request with the same idempotency key reclaims and re-runs the same row
  instead of returning a status that can never change.
- Next: analytics summary, alert create/update/pause commands, APNs HTTP/2
  trade fan-out (credentials), rotate secret, test delivery, delivery
  history, and foreground command streaming.

## Production Boundaries

- Mobile/web app work must not require production deploys, remote D1 migrations,
  queue drains, production crawlers, or backfills unless Jay explicitly asks.
- If a contract change needs a migration or production backfill, document that
  in the PR and keep the code path safe before the production step runs.
