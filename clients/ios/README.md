# Congress.Trade SwiftUI App

Initial SwiftUI iPhone client scaffold for the same backend-owned API used by
the PWA.

## Contract

- Base API: `https://congress.trade/api/client/v1`
- Auth: opaque session token in Keychain, sent as `Authorization: Bearer <token>`
- Reads: bootstrap and feed
- Writes: command gateway for preferences and webhook/SSE configuration
- Not allowed on device: scraping, calculations, provider secrets, admin tokens,
  migrations, MCP orchestration, or direct Cloudflare operations.

## Suggested Xcode Setup

1. Create a new iOS App target named `CongressTrade`.
2. Add the Swift files in `CongressTrade/`.
3. Set the deployment target to iOS 17 or later.
4. Add `KeychainTokenStore` to the app target.
5. Wire Sign in with Apple or the existing web auth flow to obtain the backend
   opaque session token, then save it with `KeychainTokenStore.save(_:)`.

The scaffold compiles as normal SwiftUI source once placed in an Xcode iOS app
target.
