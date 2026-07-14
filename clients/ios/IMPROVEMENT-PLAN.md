# Congress.Trade iOS improvement plan

Status: proposed roadmap based on `origin/main` at `4667ffb` (2026-07-13). This is a code review, not an Instruments trace. Performance items below are hypotheses until measured on a release build.

Baseline verification: the unsigned generic iOS Simulator build succeeds with Xcode 27 beta. Unit/UI execution is not a current receipt because this machine has no installed iOS Simulator runtime; CI must install/pin one as the first delivery slice.

## Product objective

Ship the SwiftUI app as a trustworthy peer of the PWA: the Worker owns identity, data, entitlements, commands, and notification state; the phone provides a fast, accessible, offline-tolerant control surface. No provider keys, scraping, calculations, admin tokens, or orchestration belong in the client.

## Current baseline

- The app targets iOS 17 and has feed, detail, watchlist, subscription, command-status, Keychain, and a 500-trade SwiftData cache.
- Authentication is still a prototype: users manually paste an opaque session token in `WatchlistView`.
- `/api/client/v1/feed` supports newer-row polling with `since`, but no older-page cursor, so the app cannot load historical pages.
- The UI initially shows House, Senate, and Executive chips as selected, but its feed request sends no chamber filter and the backend intentionally excludes Executive by default. The visible filter state is therefore false.
- Forward refresh fetches only one 50-row ascending page. More than 50 new rows between refreshes can remain undiscovered until a later refresh.
- Sync inserts only rows newer than one cache-wide maximum cursor. Existing-cursor edits and server retractions can remain stale forever, and one watermark will be unsafe once queries have independent filter/snapshot boundaries.
- A failed command is replayed forever for the same idempotency key, while the store intentionally retains that key after an error. Retrying the same user intent can therefore become permanently sticky.
- One `CongressTradeStore` publishes feed, identity, preferences, deliveries, command state, notices, and loading flags to every tab.
- `FeedDashboardView` repeatedly derives a filtered array from the full cache and applies a spring animation keyed to the entire result array. Each scrolling card also uses material, overlays, gradients, and a shadow.
- Unit tests cover several API/header/idempotency behaviors, but there is no iOS CI job, UI-test target, release pipeline, crash/performance telemetry, or App Store configuration.

## Priority roadmap

### P0 — Release and identity foundation

1. **Correct the shared contract before release**
   - Make chamber selection truthful end-to-end: send the selected `chambers` set, or change the default contract and UI together. Add an explicit regression proving Executive rows are included only when the UI says they are.
   - Drain every newer-row page until `count < limit` (with a safety cap), and carry `Retry-After` through the API client.
   - Version mutable rows and carry tombstones/retractions, or periodically reconcile against an authoritative bounded snapshot. Scope each sync watermark to its query/filter and snapshot boundary.
   - Define retry semantics for terminal failed commands. A retryable same intent needs a new attempt identity linked to the prior command; a replayed failure must not trap the user indefinitely.

2. **Production authentication**
   - Prefer Sign in with Apple when it can exchange an Apple identity assertion for the existing backend-owned session; otherwise use an `ASWebAuthenticationSession` handoff to the web login.
   - Bind state/nonce to the initiating device session and return a short-lived, single-use exchange code through the universal-link callback—never a bearer token in a URL. Keep only the exchanged opaque backend token in Keychain and revoke it server-side on sign-out.
   - If Google or another third-party login remains available, include the equivalent privacy-preserving Apple login path required by App Review.
   - Remove the manual token field from release builds. Keep an explicit debug-only injection path for local testing.
   - Add tests for success, cancellation, expired/revoked sessions, callback mismatch, reinstall/Keychain behavior, and logout retry.

3. **Signing, commerce, and distribution**
   - Set the production team, bundle ID, version/build automation, app icon validation, associated domains, Sign in with Apple and push entitlements only when their backend paths exist.
   - Decide the App Store commerce model before submission. Premium unlocks digital alert functionality, so use StoreKit where required or deliberately ship a no-purchase-in-app reader/control path that satisfies the applicable App Review rules.
   - Complete App Store Connect privacy answers, privacy policy and support URLs, metadata/screenshots, export-compliance answers, and an account-deletion route surfaced in-app. Add a privacy manifest when the app or any included SDK uses a covered required-reason API.
   - Put the privacy-policy link inside the app, provide App Review with a working demo/Premium path, and define distinct beta/production API configurations without embedding secrets.
   - Add a protected TestFlight lane before App Store submission. Never use production provider/admin credentials in CI or the client bundle.

4. **iOS CI gate**
   - On every client/backend-contract PR: use a pinned stable, App-Store-supported Xcode; build the generic simulator target, run unit tests on a pinned available simulator, archive a release configuration without uploading, and retain `.xcresult` artifacts.
   - Gate release branches on build, tests, secret scan, and backend contract fixtures.

**P0 exit criteria:** House/Senate/Executive filters match actual server results, forward sync cannot strand page 2, failed intents can recover safely, a new user can authenticate without copying or URL-transporting a bearer token, relaunch with a valid session, revoke it, and complete account deletion; commerce has a documented App Review path; a signed release archive and TestFlight build are reproducible from CI.

### P1 — Complete the mobile product loop

1. **Historical pagination and sync**
   - Extend the shared feed contract with an opaque older-page cursor while preserving `since` for forward sync. Return stable `nextOlderCursor`, `hasMore`, and retry metadata.
   - Add an actor-isolated repository that deduplicates by server identity/cursor, merges pages transactionally, trims only after a successful save, and never advances sync state on partial failure.
   - Add pull-to-refresh that drains all newer pages, plus explicit/infinite older-page loading with cancellation and 429 `Retry-After` handling.
   - Poll while foreground-active using the server's `nextPollAfterSec`, pause with app lifecycle changes, and apply bounded exponential backoff/jitter for 429 and transient failures.

2. **Alerts and notification settings**
   - Replace the comma-separated watchlist editor with searchable ticker selection and server validation.
   - Add backend-owned device registration, APNs token rotation/removal, per-account alert rules, quiet hours, delivery status, and deep links to the exact trade.
   - Separate watchlists from alert rules. Define whether watchlist changes update existing subscriptions, and use typed/versioned notification settings with optimistic conflict control for multi-device edits.
   - Keep webhook/SSE controls as advanced delivery options; push alerts should be the normal iPhone path.

3. **Useful detail and discovery**
   - Use the existing ticker/member/detail endpoints for navigable ticker and filer screens instead of limiting discovery to local text filtering.
   - Add shareable universal links, watch/unwatch actions, source-document opening, freshness/provenance labels, and clear premium gating driven only by server entitlements.

**P1 exit criteria:** users can page backward, receive and open an account-scoped alert, change notification rules on one device and see them on another, and recover cleanly from offline/429/server-error states without duplicate rows or commands.

### P1 — State and performance hardening

1. **Narrow observation scope**
   - Split the root store into session, feed, preferences, delivery, and command feature models/repositories. Inject only the model each tab needs; prefer Swift Observation where it reduces broad invalidation.
   - Represent each operation with explicit idle/loading/success/failure state and make task cancellation/last-write-wins behavior deliberate.

2. **Make feed derivation predictable**
   - Compute the filtered result once per input change, or push chamber/search predicates into SwiftData where measurement shows a benefit. Do not recompute it multiple times during one body evaluation.
   - Remove collection-wide `.animation(..., value: filteredTrades)`. Animate insertions/removals locally and respect Reduce Motion.
   - Profile material, shadow, overlay, and gradient cost in `TradeCard`; simplify only effects that show measurable scroll/render impact.

3. **Move persistence work off the UI critical path**
   - Batch inserts/deduplication/trim in a model actor or background context, then publish a small result on the main actor.
   - Define and test cache migration, corruption recovery, storage limits, and stale-data semantics.

4. **Measure before and after**
   - Capture release-build cold/warm launch, refresh-to-visible, main-thread stalls, memory, SwiftUI body updates, and a repeatable 500-row scroll using Instruments/MetricKit/signposts on a fixed oldest-supported device.
   - Treat code review as a hypothesis generator; retain trace names and device/OS/build metadata with each result.

**Performance exit criteria:** on the fixed oldest-supported device and Release build, 500-row p95 filter time is under 100 ms, cold launch is under 2 s, no hang reaches 250 ms, and scroll hitch ratio stays under 1%; no dropped-update bugs in offline/refresh scenarios; before/after trace receipts are retained.

### P2 — Accessibility, reliability, and observability

- Support Dynamic Type through accessibility sizes, VoiceOver order/actions, sufficient contrast, Reduce Motion/Transparency, keyboard/focus behavior, and non-color status cues.
- Replace forced dark mode with system choice unless product requirements and accessibility testing justify it.
- Add localized strings and locale-safe date/number/currency formatting before release.
- Use privacy-safe `Logger`, MetricKit, and the fleet crash/error pipeline. Record route templates, duration, status class, app/build/OS, and connectivity—not tokens, URLs with secrets, payloads, names, tickers tied to an account, or filing contents.
- Surface offline/stale state, last successful sync, retry timing, command progress, and one-time-secret handling consistently across tabs.

**P2 exit criteria:** automated accessibility audit plus manual VoiceOver/Dynamic Type/Reduce Motion passes; crash-free and responsiveness dashboards are build-versioned; logs contain no session or account-sensitive values.

## Test matrix

- **Unit:** DTO decoding compatibility, URL construction, auth interception, pagination merge/dedupe, idempotent command retries, cancellation, 401/403/429/5xx handling, cache trim/migration, date/amount formatting.
- **Contract:** shared JSON fixtures exercised by Worker, PWA, and Swift tests; additive/nullable compatibility rules; CI fails on a breaking `/api/client/v1` change.
- **Integration:** ephemeral URL protocol plus in-memory SwiftData for refresh, offline cache, auth expiry, command replay, and subscription mutation.
- **UI:** guest feed, sign-in/cancel/sign-out/delete, search/filter, older-page loading, watchlist/alerts, push deep link, offline relaunch, one-time delivery credential, accessibility sizes.
- **Performance:** release-mode launch, 500-row scroll, filter/search, background refresh, and repeated pagination on the oldest supported device class.

## Recommended delivery slices

1. CI + contract fixtures + baseline performance traces.
2. Backend auth exchange/callback + iOS production auth + account deletion.
3. Opaque older-page cursor + repository/sync/pagination.
4. Device registration + push alert rules + deep links.
5. Feature-scoped state and measured feed/render/persistence fixes.
6. Accessibility/localization/observability hardening and TestFlight release candidate.

Each slice should be a separate reviewable PR with backend/iOS contract changes landed together when required. Styling work can continue independently, but visual changes should not mask the trace-backed performance and accessibility gates above.

Current AG styling work overlaps the SwiftUI view files. Land backend/repository/test slices independently, then sequence behavioral/accessibility view edits after that lane or stack them explicitly to avoid conflicting rewrites.
