# Full-Stack Improvement Analysis — 2026-07-28

**Author:** KIMI (Kimi Code CLI), read-only analysis across three parallel lanes (backend, web UI, iOS app).
**Scope:** `app/` (Deno backend + server-rendered web UI), `clients/ios/` (SwiftUI app), API/interop surface.
**Status:** Analysis only — no code changed. Tasks derived from this document are tracked as Planned rows on the effort board (`docs/EFFORT-LOG.md`) and mirrored to GitHub Issues by `scripts/sync-effort-issues.py`.

---

## Executive summary

The codebase is unusually defensive (leases, outboxes, circuit breakers, migration-parity tests). The biggest gaps are not internal quality but **product surface**: iOS sign-in is broken (unregistered URL scheme), there are no push notifications despite an "Alerts" tab, and nothing on any surface is shareable (no OG tags, no deep links, no ShareLink). Behind those sit real efficiency wins (SSE cross-region starvation, doubled Turso round trips on the queue hot path, an 833 KB single-file web UI) and an interop story that currently *blocks* third-party consumers by design.

### Top cross-cutting findings

1. **iOS sign-in is broken.** Google OAuth redirects to `congresstrade://auth?token=…` (`app/src/auth/routes.ts:176-178`, `SettingsView.swift:130`), but the Xcode project uses a generated Info.plist with no `CFBundleURLTypes` (`clients/ios/CongressTrade.xcodeproj/project.pbxproj:444-452`). `ASWebAuthenticationSession` cannot deliver the callback to an unregistered scheme.
2. **No push notifications anywhere** — yet the iOS tab is named "Alerts" and the Premium promise is "the filing the moment we see it." No APNs entitlement, no device-token backend endpoint, no alert-rules UI.
3. **Nothing is shareable.** The website has zero Open Graph/Twitter/meta tags (`dashboardHtml.ts:31-46`), no deep links (`?trade=`/`?ticker=`/`?member=` unhandled, `:8483`), no favicon/manifest, no RSS. iOS has no ShareLink, no universal links, no `onOpenURL`. Web deep links are also the prerequisite for iOS universal links.
4. **SSE live tail silently starves cross-region.** `app/src/delivery/sse.ts:311-386` relies on `BroadcastChannel`, which does not span Deno Deploy regions; a Premium subscriber in the wrong region gets no trades until the 25-min reconnect, with no error surfaced. Fix: periodic `drainSseBacklog` inside the keep-alive loop.
5. **Queue hot path doubles every Turso round trip.** Every proxied statement awaits `lease.assertOwned()` → its own DB query (`app/src/deno/durableQueue.ts:571-575`). A 30-statement handler pays ~60 round trips. Fix: cache ownership within a freshness window / assert at handler boundaries.

---

## 1. Backend (`app/src/**`)

### 1.1 Efficiency

| Priority | Finding | Evidence | Fix |
|---|---|---|---|
| HIGH | Lease-fencing proxy doubles Turso round trips on queue hot path | `deno/durableQueue.ts:571-575, 599-603, 654-657`; assert query at `:480-489`; heartbeat `:525-549` | Cache ownership check in-memory for a short window; assert once per `batch()`; rely on heartbeat to abort |
| HIGH | SSE live tail has no periodic DB fallback; cross-region/isolate clients silently starve | `delivery/sse.ts:311-386`; `drainSseBacklog` only re-invoked on gap from an already-received broadcast `:324-327`; broadcast origin `webhook.ts:204-216` | Low-frequency `drainSseBacklog` in keep-alive loop (30–60 s; cheap indexed `cursor_seq > ?` read) |
| MEDIUM | `pub-api` rate limit is per-isolate only (documented global cap doesn't exist) | `shared/rateLimit.ts:174-178`, `security/botDefense.ts:39-40` | Document as per-isolate, or shard counter (KV write every N admits) |
| MEDIUM | `memberName` filter forces un-indexed full-corpus path | `delivery/rows.ts:409-412`, `canNestTransactionKeyset` false at `:460-467` | Lowercase generated column + index on filers, or resolve name → `filer_id` first (pattern at `client/queries.ts:121-137`) |
| MEDIUM | COUNT companion queries join `securities_ref` needlessly | `delivery/rows.ts:554-577`, joins at `:363-367` | Joins-lite FROM for count/today queries |
| LOW | No index on `filings.filed_date`; daily retention sweep full-scans | `jobs.ts:148-153`; indexes at `migrations/0001_init.sql:32-33` | `CREATE INDEX idx_filings_filed_date` (mirror in `admin/migrations.ts`) |
| LOW | Duplicated helpers across routers; `admin/routes.ts` is 8,977 lines with a stray `routes.ts.orig` checked in | `delivery/rest.ts:64-182` vs `client/utils.ts`; `analytics/routes.ts:117-121` vs `shared/db.ts:145-154` | Consolidate into `shared/`; delete `.orig`; split admin router |

### 1.2 API design & interoperability

| Priority | Finding | Evidence | Fix |
|---|---|---|---|
| HIGH | No OpenAPI spec for the app's own API; repo-root `deno_openapi.json` is *Deno Deploy's* API, easy to mistake for app docs | `deno_openapi.json` (title "Deno Deploy API"); only `app/docs/client-mobile-api.md` exists | Generate/hand-maintain `openapi.yaml` for public routes; move/rename `deno_openapi.json` |
| HIGH | Third-party consumption blocked by design: UA blocklist 403s all conventional HTTP clients, no API keys, zero CORS | `security/botDefense.ts:71-81`; auth is human-OAuth only `auth/session.ts:168-200`; no `Access-Control` headers anywhere | Per-user/integration API keys (`Bearer ct_…`) bypassing UA layer but keeping row budgets; explicit CORS policy on read-only GETs |
| MEDIUM | Versioning inconsistent: only `/api/client/v1` is versioned | `index.ts:90-109` | Freeze current shapes as implicit v1 (document); prefix future surfaces |
| MEDIUM | Pagination conventions diverge; `/api/market/*` endpoints unbounded | `delivery/rest.ts:234-330`, `:538-704`; fake list envelope `client/routes.ts:129-136` | Add `limit`/default windows; document cursor contract; drop synthetic envelope in v2 |
| MEDIUM | `POST /api/client/v1/commands` executes synchronously in-request | `client/routes.ts:345-355` | Enqueue on the durable queue, return 202; poll via existing `GET /commands/:id` |
| LOW | Error shape informal; `GET /api/subscriptions` returns 401 for "listing disabled" (should be 403/410) | `delivery/rest.ts:807-812` | Adopt `{error:{code,message}}`; fix the 401 |
| LOW | No `Cache-Control` on public GETs (e.g. `/api/members` is KV-cached server-side but not edge-cacheable) | `delivery/rest.ts:713` | Short `s-maxage` + `stale-while-revalidate` |

### 1.3 Reliability

| Priority | Finding | Evidence | Fix |
|---|---|---|---|
| HIGH | 45s cron race abandons the tick without cancellation; slow ticks can overlap (watcher/outbox unguarded) | `deno/main.ts:130-148`; `deno/scheduledTick.ts:119-229` accepts no `AbortSignal` | Thread `AbortSignal` from the timeout; KV/DB singleton lease per tick |
| MEDIUM | Two divergent cron orchestrations (Cloudflare `scheduled()` vs Deno tick) — already drifted once | `index.ts:499-613` vs `deno/scheduledTick.ts:119-229` (drift comment `:154-156`) | Extract one `runMaintenancePipeline(env, profile)` used by both |
| MEDIUM | SSE subscription token in URL query string (browser history, proxy logs, Referer) | `sse.ts:9-11`, `rest.ts:107-110` | `Last-Event-ID` + short-lived signed stream URLs; stop returning reusable `streamUrl` on GET |
| LOW | Filing-retention sweep orphans `deliveries`/`delivery_outbox` rows; NULL `filed_date` rows never swept | `jobs.ts:142-194` | Include both tables in batch delete; review NULL predicate |
| LOW | `/api/health` (uptime-monitor target) does schema introspection per hit; static `/health` exists | `delivery/rest.ts:209-217` vs `index.ts:84` | Cache readiness ~60 s, or point monitors at `/health` |

### 1.4 Security / correctness flags (brief)

- Webhook re-validation per attempt is **good** (`webhook.ts:351-356`) — verified, not a finding.
- Fail-open rate limiting everywhere (`rateLimit.ts:155-208`, `botDefense.ts:143-163`) — deliberate, but a KV outage removes all throttles; ensure alerts on KV error rates.
- `/api/logos/ticker` resolves a secret per request (`rest.ts:419-421`) — relies on resolveSecret cache; logo-heavy page could storm Infisical.
- Public feed embeds `rawText` of filings (`rows.ts:151`) — intended evidence trail, but any PII slipping past the extractor is publicly served; spot-check redaction-before-publish.
- ~20 scratch `fix_*.py`/`test_*.ts` files at repo root and in `app/` pollute the deploy context.

---

## 2. Website (`app/src/ui/dashboardHtml.ts` — 8,706 lines / 833 KB single-file SPA)

### 2.1 UX / intuitiveness

| Priority | Finding | Evidence | Fix |
|---|---|---|---|
| HIGH | No deep links/share URLs for trades, assets, politicians; only `?view=` understood | `dashboardHtml.ts:8370-8375`, `:8483-8484` | Handle `?trade=`/`?ticker=`/`?member=` on boot (data endpoints exist); "Copy link" button per drawer |
| HIGH | CSV-export copy contradicts server: UI says Premium, endpoint deliberately ungated in #558 | `:1651`, `:3514` vs `delivery/rest.ts:335-347` | Product decision, then align copy or restore gate |
| HIGH | Delivery management is create-and-list only: filters uneditable (`filters: {}` hardcoded), no pause/resume/delete despite API support | `:4605-4634`; `PATCH /api/subscriptions/:id` at `rest.ts:825` | Filter form on create; per-row Pause/Resume/Delete |
| HIGH | Eagle splash hides app ~2.6 s once per *session* (sessionStorage) | `:1495-1501`, `:8584`, `:8643` | Persist seen-flag in localStorage; shorten animation |
| MEDIUM | "Search All"/Min/Max $ only filter the current page client-side | `:1627-1631`, `:3061-3068` | Push params to server via `feedQueryParams()` (`:3406-3427`) or relabel "filter this page" |
| MEDIUM | Filter state lost on refresh/share (only active tab in URL) | `:8483-8496` | Mirror filters + Trends window into query params |
| MEDIUM | Polling/SSE keep running in hidden tabs (no `visibilitychange` handler) | `:3563-3584` | Pause interval + close EventSource on `document.hidden` |
| MEDIUM | A11y gaps: placeholder-only labels, no `aria-sort`, brand img no `alt` | `:1579-1580`, `:1738-1742`, `:1561` | Real labels, `aria-sort` in `updateSortIndicators()` (`:3264`), `alt` |
| LOW | Native `alert()` in admin flows while a styled toast exists | `:4231` etc. vs `showToast` `:8083` | Route through `showToast` |

(Mobile is otherwise well-handled: bottom tab bar, safe-area insets, card layout, 44 px targets, reduced-motion — don't regress.)

### 2.2 Frontend efficiency

| Priority | Finding | Evidence | Fix |
|---|---|---|---|
| HIGH | 833 KB HTML with 5 inline base64 assets, none cacheable; defeats compression and CSP | `wc -c` = 832,969; font `:127`, eagle `:1557`, logo `:1561`; served per-request `ui/routes.ts:38-44` | Extract font/images to hashed static assets with long cache; expect <100 KB compressed HTML |
| MEDIUM | No response caching for analytics; 12 parallel fetches per window change; drawer re-opens refetch | `aGet` `:6678-6682`, `loadTrends` `:6823-6828`; existing TTL+dedupe pattern at `:6842-6851` | Wrap `aGet` in small TTL memo cache |
| MEDIUM | `runOgeBackfill` defined twice (second silently wins) | `:4850` and `:4889` | Delete one |
| LOW | Dead stub `syncPanelBackdrop()`; render-blocking Google Fonts while another font is inlined; root-level untracked UI test cruft; 179 MB stale `clients/pwa/.next` | `:2969`, `:35-37`, `test-fmtCompany.js`/`test-normalizer.ts` | Clean up |

(Already good, don't "fix": request abortion + sequence guards, SSE→poll fallback, 10k-row paging cap, idempotency keys on checkout/subscription, focus-trapped modals, skeleton loaders.)

### 2.3 Web interop

- **HIGH:** No OG/Twitter/meta description at all (`:31-46`) — every shared link unfurls blank. Add meta set + static 1200×630 image (`docs/brand/assets/` exists).
- **MEDIUM:** No RSS/Atom feed — `GET /feed.xml` over the existing query builder is ~50 lines and plugs into IFTTT/Zapier.
- **MEDIUM:** No favicon/manifest/apple-touch-icon — an orphaned full icon set + manifest already exists in `clients/pwa/out/`.

---

## 3. iOS app (`clients/ios/CongressTrade/**`, ~3,000 lines Swift)

### 3.1 Feature inventory

- **Shell:** 4 tabs (Trades, Trends, Alerts, Settings); ~2.4 s eagle splash every cold launch; theme override; SwiftData cache of ~400–600 trades.
- **Trades:** bootstrap + feed snapshot (≤200 rows); chamber chips H/S/P; time-range picker; local-only text search (180 ms debounce); pull-to-refresh; offline banner; KPI tiles; trade detail sheet (with retraction reconciliation); politician detail sheet (performance vs S&P).
- **Trends:** window chips; Market Snapshot; Buys-vs-Sells; Most-Traded Assets; Consensus Moves; Net Flow by Sector; Most Active Politicians; provider-latency scorecards.
- **Alerts (Delivery):** create SSE/webhook subscription (idempotency-keyed); list; pause/resume; one-time credential sheet (correctly no ShareLink).
- **Settings:** Google sign-in via `ASWebAuthenticationSession`; Keychain token storage; profile/plan; sign out with server revoke.
- **Absent entirely:** watchlist UI, command-history UI, ticker detail, push, widgets, App Intents, share sheets, deep/universal links, PDF viewer, billing/upgrade, account deletion, background refresh.

### 3.2 Parity gaps vs web/backend

| Priority | Gap | Evidence | Fix |
|---|---|---|---|
| HIGH | `congresstrade://` scheme unregistered → sign-in callback broken | `SettingsView.swift:130`, `auth/routes.ts:176-178`, `project.pbxproj:444-452` | Register `CFBundleURLTypes`; contract-test the round trip |
| HIGH | No billing/upgrade path; Delivery create not premium-gated in UI (free users hit raw server error) | `DeliveryView.swift:38`; web pricing modal `dashboardHtml.ts:2174-2196`; entitlement already decoded `Models.swift:22-26` | Read `bootstrap.auth.entitlement.premium`; Premium explainer + checkout path |
| HIGH | Watchlist feature unreachable (dead UI) yet silently used as delivery ticker filter | `CongressTradeStore.swift:311-334,341,353,364`; zero `WatchlistView` call sites | Add watchlist editor or stop pretending the filter is user-controlled |
| HIGH | Command status fetched but never rendered | `CongressTradeStore.swift:21,31-32`, `APIClient.swift:183-191` | Command/activity history section or delete the fetch |
| MEDIUM | No ticker detail screen (backend `GET /client/v1/ticker/:ticker` exists; no `ticker()` in APIClient) | `client/routes.ts:139-170`; `APIClient.swift` | Add `ticker()` + TickerDetailView mirroring PoliticianDetailView |
| MEDIUM | No in-app filing PDF (`docId` already in models) | `Models.swift:41`, `TradeDetailView.swift:69-84` | "View Filing PDF" → `/api/client/v1/documents/:docId/pdf` |
| MEDIUM | No live updates; `nextPollAfterSec` decoded but never scheduled | `Models.swift:34`, `App.swift:62-67` | Foreground timer honoring `nextPollAfterSec`, paused in background |
| MEDIUM | No historical pagination (single ≤200-row snapshot; needs backend older-page cursor) | `CongressTradeStore.swift:72,143-152`; `README.md:83-84` | Shared-contract cursor + load-more UI |
| MEDIUM | Search is cache-only while `FeedQuery` supports server-side `ticker`/`member`/`type` | `FeedDashboardView.swift:26-52`, `APIClient.swift:42-46` | Server-filtered query on submit, or explicit filter controls |
| MEDIUM | Delivery filters reduced to tickers; contract supports chambers/members/amounts (models decode them all) | `APIClient.swift:217-249`, `Models.swift:173-187` | Expose chambers + members in create form |
| MEDIUM | No magic-link sign-in (backend supports `?client=ios`); no Sign in with Apple (App Review requirement) | `auth/routes.ts:186-233`, `SettingsView.swift:125-147` | Add both before release |
| MEDIUM | 13 of 20 analytics endpoints unused; party-split/trending/filing-lag are cheap wins | `analytics/routes.ts:264-1178` vs `APIClient.swift:140-172` | Extend Trends tab |

### 3.3 UX / code quality

- **HIGH:** Alerts tab gives logged-out users a silently-disabled button, no CTA, no Premium mention (`DeliveryView.swift:38,49`).
- **HIGH:** `replaceCache` wipes the whole SwiftData store every refresh — delete-all + re-insert, non-transactional, main-actor (`CongressTradeStore.swift:232-243`). Fix: upsert by `id`, one `save()`, background `ModelActor`.
- **MEDIUM:** Hardcoded prod auth host in Settings ignores `CONGRESS_TRADE_API_BASE_URL` (`SettingsView.swift:129` vs `APIClient.swift:111-115`).
- **MEDIUM:** Firebase configured/bundled but entirely unused — wire Crashlytics or remove (privacy-manifest liability either way).
- **MEDIUM:** Force-unwraps on URL construction (`APIClient.swift:115,123,125,180,185,305`); god-object store (~30 published props); dead code (`DateChip`, `refreshLatencySummary`, unused query params, undelivered `bootstrap.capabilities`).
- **MEDIUM:** Tab "Alerts" vs title "Delivery" mismatch; H/S/P chips with no legend (VoiceOver reads "H"); nested buttons in trade cards; no onboarding; politician detail error state has no retry; partial Dynamic Type support.
- **LOW:** Duplicate Trends window controls; trends-window change refetches the whole feed; retry cap discards large `Retry-After`; per-call `DateFormatter` allocation; `reloadIgnoringLocalCacheData` on every request; no SwiftData migration plan (`VersionedSchema` before release).

### 3.4 iOS interop (all currently absent)

- **HIGH:** Push notifications end-to-end (backend device registration + APNs + alert-rules UI).
- **MEDIUM:** Universal links / deep links (`onOpenURL`) matching web URLs; ShareLink on trade/politician detail.
- **MEDIUM:** WidgetKit "Latest Trades" widget (App Group snapshot).
- **LOW:** App Intents/Siri; background refresh (`BGAppRefreshTask`).

---

## 4. Prioritized task list (as entered on the effort board)

**Week-one fixes (small, independent):**
1. iOS: register `congresstrade` URL scheme (sign-in broken without it).
2. Backend: SSE cross-region live-tail fallback (`sse.ts`).
3. Backend: lease-assert round-trip coalescing (`durableQueue.ts`).
4. Web: OG/Twitter/meta tags + favicon/manifest.
5. Web: deep links (`?trade=`/`?ticker=`/`?member=`) + copy-link buttons.
6. Product decision: CSV export gate vs copy contradiction (#558), then align.

**Next:**
7. iOS: premium gating + upgrade path on Alerts tab.
8. iOS: ticker detail screen + filing PDF viewer.
9. iOS: watchlist editor UI (or remove silent filter coupling).
10. Web: delivery pause/resume/delete + filter editing (API exists).
11. Web: extract base64 assets from the 833 KB HTML.
12. iOS: SwiftData `replaceCache` → upsert.
13. Both: server-side search wiring.
14. Backend: query optimizations (memberName index, COUNT joins, `filings.filed_date` index).
15. Backend: consolidate cron orchestrations + AbortSignal; async command execution (202).
16. Web UX: splash persistence, visibility-aware polling, URL-synced filters, a11y pass.

**Bigger investments:**
17. Push notifications end-to-end (backend device registration + APNs + alert UI).
18. Interop package: API keys + OpenAPI spec + CORS + RSS feed.
19. Universal links + ShareLink + widgets + App Intents; Sign in with Apple + magic link.

**Housekeeping:**
20. Delete `admin/routes.ts.orig`, scratch scripts, stale `clients/pwa/.next`; fix duplicate `runOgeBackfill`; iOS dead-code sweep + Firebase decision; split god-object store.

---

## 5. Open questions for the owner

1. **CSV export policy** — ungated on purpose (#558) or accidentally? Copy and gate must agree either way.
2. **Third-party API access** — is the UA blocklist + no-keys stance deliberate product policy, or should there be a paid/free API-key tier? The interop package (#18) depends on this.
3. **Push notifications** — Premium-only, or free tier with delayed alerts? Drives the backend device-registration design.
4. **iOS release scope** — Sign in with Apple + account deletion are App Review blockers; confirm the app is pre-release so these can be sequenced.
