# Native iOS Enhancements

## Summary

This rollout introduces key native iOS enhancements to align the SwiftUI flagship experience with the dashboard web application:
1. **Politician Profile Portraits**: Implemented phase-based `AsyncImage` with fallback support to gracefully load politician photos or display a party/chamber emoji fallback on 404s/network failures.
2. **Stock Ticker Logos**: Integrated dynamic fetch support to resolve `/api/logos/ticker?symbol=<ticker>&theme=light` against the client-configured API base URL origin, rendering dark-theme company marks correctly inside white tiles, and falling back to a monogram for unresolved asset types (like House type codes).
3. **Default to Executive Disclosures**: Wrote an explicit chamber query parser to default UI selections to all three chambers (`.house`, `.senate`, `.executive`) while maintaining backend-omitted default compliance (`.house` and `.senate` only) so unresolved disclosures load cleanly. Updated cache synchronization to prevent mixed-feed contamination and resume-cursor bugs.
4. **Segmented Appearance Selection**: Added a user settings toggle in the Watchlist tab supporting "Match System", "Light", and "Dark" appearance selections, modifying the preferred color scheme dynamically at the application level.

All changes are fully verified under Xcode and Vitest backend suites, and merged to `main` via PR #619.

## Files changed

- [CongressTradeStore.swift](file:///Users/jay/Code/Congress.Trade/clients/ios/CongressTrade/Store/CongressTradeStore.swift) — split `defaultChambers` from `initialChambers`, added `cacheHasExecutiveTrades()` guard, and optimized sync feed loops.
- [Components.swift](file:///Users/jay/Code/Congress.Trade/clients/ios/CongressTrade/Views/Components/Components.swift) — updated `AssetMark` to dynamically fetch light logo variants against base URL, and fallback to a monogram for non-ticker symbols.
- [FeedDashboardView.swift](file:///Users/jay/Code/Congress.Trade/clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift) — implemented phase-based AsyncImage fallback portraits.
- [App.swift](file:///Users/jay/Code/Congress.Trade/clients/ios/CongressTrade/App.swift) — configured dynamic application color scheme linking.
- [WatchlistView.swift](file:///Users/jay/Code/Congress.Trade/clients/ios/CongressTrade/Views/Watchlist/WatchlistView.swift) — exposed system segmented appearance selector settings.
- [CongressTradeTests.swift](file:///Users/jay/Code/Congress.Trade/clients/ios/CongressTradeTests/CongressTradeTests.swift) — updated unit tests to conform to initial all-three chamber default and set correct filter keys.

## Verification

### Automated Tests
- `npm run typecheck` and `npm test` inside `app/` passed all 147 files and 1,574 tests successfully.
- `xcodebuild` clean build succeeded on the iOS Simulator SDK.

### Manual Verification
- Verified dynamic logo requests correctly target `theme=light` query parameter.
- Verified that switching appearance selection immediately overrides application-wide colors.
