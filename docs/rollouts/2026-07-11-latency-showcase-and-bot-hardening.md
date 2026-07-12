# Public latency showcase, public delivery education, anti-scrape hardening

Branch: `claude/antigravity-latency-security-x6lkvb` (Claude). Not deployed by
this change; production rollout happens via the canonical
`bash app/scripts/ship.sh` when Jay approves.

## Summary

Three related changes from one request:

1. **Public "Speed vs. Data Providers" scoreboard.** The disclosure-latency
   race monitor (Congress.Trade first-seen vs FMP / Unusual Whales / Quiver)
   was admin-only. A new public endpoint
   `GET /api/analytics/latency-summary` serves ONLY the aggregate
   `publicSummary` (no doc ids / filer names / payloads; pinned by tests) with
   renamed public fields, KV-cached 5 minutes, `Cache-Control: public`.
   The dashboard's default Trends view renders it as a race-lane scoreboard
   (hero lead number + per-provider lanes + accessible table twin), designed
   by a three-expert UI panel with honesty guard rails: full lane only at
   ≥5 matched filings, text-only below, neutral "no overlapping disclosures
   yet" empty states, negative medians rendered truthfully, boast copy
   (compact strip + pricing-modal proof line) only at ≥10 matches AND a
   positive median, sample sizes always shown, losses always shown, and the
   whole module hides in unfavorable windows rather than spinning.

2. **Delivery methods learnable while signed out.** The admin-only
   "Developer Delivery" tab is now the public **Alerts** tab: marketing/
   education cards for the two paid delivery methods (signed webhooks —
   HMAC-SHA256, retries; SSE live stream — EventSource, resume) visible to
   everyone, with a Premium CTA (`openPricing('alerts')`) that hides for
   premium/admin users. The management table/form moved into a
   `data-admin-only` block that stays hidden for non-admins; `loadSubs()` is
   only called when `canUseAdmin()`. The pricing modal now lists both
   delivery methods first and carries a guard-railed live proof line.

3. **Anti-scrape hardening for the (fully public) site.** New
   `app/src/security/botDefense.ts`, mounted on `/api/*` before the routers:
   - user-agent blocklist (curl/wget/python/scrapy/go/node HTTP libs,
     headless browsers, and the AI crawlers robots.txt already disallows) →
     403 on public data endpoints; browsers, EventSource, and iOS
     CFNetwork/URLSession agents unaffected;
   - per-IP request budget 300 / 5 min across public data endpoints → 429;
   - per-IP daily served-ROW budget (20,000/day) shared by
     `/api/transactions` and `/api/client/v1/feed` — incremental polls cost
     ~0, corpus walks exhaust it → 429 + `Retry-After`;
   - public `offset` capped at 10,000 on `/api/transactions` (the UI pager
     mirrors the cap; deeper history = Premium CSV export / token-gated bulk
     snapshot);
   - `X-Robots-Tag: noindex` on all `/api/*` responses.
   Token-gated surfaces (`/api/admin`, `/api/ingest`, `/api/export`),
   `/api/health`, `/api/stream`, and `/api/logos` are exempt. Everything
   fails OPEN on KV errors. Kill switch: `SCRAPE_GUARD_ENABLED`
   (wrangler var, Infisical-overridable live; unset = off, so tests/dev opt
   in). No page or endpoint became sign-in-gated: the site stays fully
   public for humans.

## Files changed

- `app/src/security/botDefense.ts` (new) + `__tests__/botDefense.test.ts`
- `app/src/index.ts` — guard mounted on `/api/*`
- `app/src/delivery/rest.ts` — offset cap + row budget on `/transactions`
- `app/src/client/routes.ts` — row budget on `/feed`
- `app/src/analytics/routes.ts` — `GET /latency-summary` (public, cached)
  + `__tests__/latencySummary.test.ts`
- `app/src/ui/dashboardHtml.ts` — speed scoreboard on Trends, public Alerts
  tab, pricing modal, pager cap, `--rival` token, mobile nav auto-columns
- `app/src/ui/__tests__/dashboardHtml.test.ts` — repinned to the new contract
- `app/src/shared/types.ts`, `app/wrangler.toml`, `app/.dev.vars.example` —
  `SCRAPE_GUARD_ENABLED`
- `app/docs/client-mobile-api.md` — feed 429/403 guard contract note

No migrations. No `/api/admin/migrate` changes.

## Verification

- `cd app && npm run typecheck && npm test` — 108 files / 957 tests green.
- Local: `npm run dev`, then with a browser UA:
  `GET /api/analytics/latency-summary` → 200 aggregate JSON (no docId);
  `GET /` contains `id="trLatencySection"` and the public Alerts tab;
  `GET /api/transactions` with `curl/8` UA → 403; with browser UA → 200;
  `GET /api/transactions?offset=20000` → 400.
- Post-deploy: same checks against https://congress.trade, plus confirm the
  scoreboard renders real probe data and Infisical can flip
  `SCRAPE_GUARD_ENABLED` to "false".

## Follow-ups

- The 0-matched providers (Unusual Whales, Quiver) render as honest empty
  states; once their probes accumulate ≥5 matches the lanes appear
  automatically.
- Consider Cloudflare-native rate limiting / Turnstile for defense in depth
  (needs dashboard provisioning; explicitly out of scope here).
- Account-owned alert resources for Premium users (roadmap) would let paying
  users self-serve webhook/SSE creation from the Alerts tab; today the
  management UI remains admin-only while the API supports signed-in creation.
