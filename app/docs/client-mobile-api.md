# Client Mobile API Coordination

Last updated: 2026-06-29

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

## Cross-App Heartbeat

Sibling trading apps (trading.jays.services) should verify connectivity via:

- `GET /api/share/heartbeat` — public, no auth. Returns `{ ok, service, version,
  time, endpoints }` listing the active API surfaces (`feed`, `analytics`,
  `market`, `export`). The trading app can call this on startup and periodically
  to confirm the backend is reachable.

## Signal Field On ClientTrade

Each `ClientTrade` DTO (feed items) now carries an optional `signal` field:

```typescript
signal?: {
  score: number | null;      // 0-100 composite conviction score
  consensus: number | null;   // sub-components for transparency
  flow: number | null;
  freshness: number | null;
  memberSkill: number | null;
} | null;
```

- `signal` is `null` (or absent) when the trade has insufficient data for
  scoring — backfilled trades, members with too little history, or before the
  PIT score engine is integrated into the feed path.
- The trading app can sort/filter/highlight trades by `signal.score` without
  implementing its own scoring model.

## How The Trading App Consumes Congressional Data

The sibling trading app at trading.jays.services has dedicated `/congress` and
`/api/congress` routes. It consumes congressional data from Congress.Trade
through:

1. **Feed polling:** `GET /api/client/v1/feed` pulls the enriched `ClientTrade`
   DTOs (now with optional `signal` scores). The trading app polls forward using
   the returned `cursor`.

2. **Heartbeat:** `GET /api/share/heartbeat` confirms connectivity and discovers
   active API surfaces on startup.

3. **PIT score export:** `GET /api/export/congress-pit-scores` (token-gated)
   provides point-in-time scores for backtesting against congressional
   disclosures. Full NDJSON contract in `app/docs/pit-score-export.md`.

4. **Market data reads:** `GET /api/market/*` routes let the trading app reuse
   Congress.Trade's cached FMP data (refs, prices, SPX) instead of calling FMP
   directly.

5. **Bulk snapshot:** `GET /api/export/bulk-snapshot` (token-gated) provides a
   daily NDJSON manifest for full-history bootstrap or catch-up.

6. **Data push:** `POST /api/admin/securities/import` lets the trading app push
   its own FMP market data back to Congress.Trade so neither app pays for the
   same FMP call twice.

## Cross-App Capabilities Manifest

Discover all available cross-app endpoints and limits at:

- `GET /api/export/capabilities` — token-gated (Bearer `INGEST_TOKEN`). Returns
  the full `CrossAppCapabilities` manifest: contract version, import/read/export
  endpoint inventory with auth requirements, import guardrail limits, and live
  PIT score parameters (weights, horizons, format). The manifest is generated
  from `app/src/share/capabilities.ts` and always reflects the live constants in
  `app/src/export/pitScores.ts`.

## Production Boundaries

- Mobile/PWA work must not require production deploys, remote D1 migrations,
  queue drains, production crawlers, or backfills unless Jay explicitly asks.
- If a contract change needs a migration or production backfill, document that
  in the PR and keep the code path safe before the production step runs.
