import Foundation

protocol SessionTokenStore {
    func load() throws -> String?
    func save(_ token: String) throws
    func clear() throws
}

/// Persists the feed sync watermark (`ClientFeedResponse.cursor`) per request
/// shape. A single global cursor is only valid for resuming the exact same
/// filter that produced it — rows excluded by a narrower filter (e.g. an
/// unselected chamber) were never fetched, so widening the filter later must
/// resume from that filter's own watermark, not whatever the last-used
/// filter happened to reach. CT-AUD-009.
protocol SyncCursorStore {
    func cursor(for key: String) -> Int?
    func setCursor(_ cursor: Int, for key: String)
}

final class UserDefaultsSyncCursorStore: SyncCursorStore {
    private let defaults: UserDefaults
    private let keyPrefix = "trade.congress.sync.cursor."

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func cursor(for key: String) -> Int? {
        let storageKey = keyPrefix + key
        guard defaults.object(forKey: storageKey) != nil else { return nil }
        return defaults.integer(forKey: storageKey)
    }

    func setCursor(_ cursor: Int, for key: String) {
        defaults.set(cursor, forKey: keyPrefix + key)
    }
}

struct FeedQuery: Equatable {
    var limit: Int = 30
    var since: Int?
    var ticker: String?
    /// Exact bioguide / filer id (`member=`). Prefer `memberName` for free-text search.
    var member: String?
    /// Free-text politician name (`memberName=` LIKE path). Used for typed search.
    var memberName: String?
    var chamber: String?
    var type: String?
    var from: String?
    var to: String?
    /// Backend sort key: `tx_date` | `published` | cursor (default). Prefer
    /// `tx_date` for the consumer feed so seed imports of old filings don't
    /// float to the top just because they got a high cursor_seq.
    var sort: String?
    var order: String?
    /// Offset-paged snapshot navigation (owner punch list #2, item 8) —
    /// `nil`/`0` omits the param (page 1). Server-guarded at
    /// `MAX_PUBLIC_TX_OFFSET` (2000); see `app/docs/client-mobile-api.md`.
    var offset: Int?

    var queryItems: [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let since { items.append(URLQueryItem(name: "since", value: String(since))) }
        if let ticker, !ticker.isEmpty { items.append(URLQueryItem(name: "ticker", value: ticker)) }
        if let member, !member.isEmpty { items.append(URLQueryItem(name: "member", value: member)) }
        if let memberName, !memberName.isEmpty { items.append(URLQueryItem(name: "memberName", value: memberName)) }
        if let chamber, !chamber.isEmpty { items.append(URLQueryItem(name: "chamber", value: chamber)) }
        if let type, !type.isEmpty { items.append(URLQueryItem(name: "type", value: type)) }
        if let from, !from.isEmpty { items.append(URLQueryItem(name: "from", value: from)) }
        if let to, !to.isEmpty { items.append(URLQueryItem(name: "to", value: to)) }
        if let sort, !sort.isEmpty { items.append(URLQueryItem(name: "sort", value: sort)) }
        if let order, !order.isEmpty { items.append(URLQueryItem(name: "order", value: order)) }
        if let offset, offset > 0 { items.append(URLQueryItem(name: "offset", value: String(offset))) }
        return items
    }
}

protocol RequestInterceptor {
    func intercept(_ request: inout URLRequest) throws
}

final class AuthHeaderInterceptor: RequestInterceptor {
    private let tokenStore: SessionTokenStore

    init(tokenStore: SessionTokenStore) {
        self.tokenStore = tokenStore
    }

    func intercept(_ request: inout URLRequest) throws {
        if let token = try tokenStore.load() {
            let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                request.setValue("Bearer \(trimmed)", forHTTPHeaderField: "authorization")
            }
        }
    }
}

final class CongressTradeAPIClient {
    private let baseURL: URL
    let tokenStore: SessionTokenStore
    private let session: URLSession
    private let interceptor: RequestInterceptor
    private let decoder: JSONDecoder

    init(
        baseURL: URL = CongressTradeAPIClient.defaultBaseURL,
        tokenStore: SessionTokenStore = KeychainTokenStore(),
        session: URLSession = .shared,
        interceptor: RequestInterceptor? = nil
    ) {
        self.baseURL = baseURL
        self.tokenStore = tokenStore
        self.session = session
        self.interceptor = interceptor ?? AuthHeaderInterceptor(tokenStore: tokenStore)
        self.decoder = JSONDecoder()
    }

    static var defaultBaseURL: URL {
        if let raw = ProcessInfo.processInfo.environment["CONGRESS_TRADE_API_BASE_URL"],
           let url = URL(string: raw) {
            return url
        }
        // Compile-time constant; a malformed override above falls through here.
        return URL(string: "https://congress.trade/api/client/v1")!
    }

    /// The App Store subscriptions page — the sole manage-subscription
    /// surface for Apple IAP subscribers (`entitlement.source == "apple"`).
    /// Stripe subscribers (and `nil`, the safe default for every payer that
    /// predates Apple IAP support — it was disabled until 2026-08-09) use
    /// `billingPortalURL()` instead; this page would show them nothing to
    /// manage.
    static let appStoreManageSubscriptionsURL = URL(string: "https://apps.apple.com/account/subscriptions")!

    /// Site origin (scheme + host) with the `/api/client/v1` path stripped.
    /// Auth (`/auth/*`), document (`/api/documents/*`), and logo endpoints live
    /// at the origin, not under the client API prefix.
    var origin: URL {
        originURL
    }

    /// URL for the filing PDF served from R2 (or redirected to the source).
    /// Mirrors `GET /api/documents/:docId/pdf` in `app/src/delivery/rest.ts`.
    func documentPDFURL(docId: String) -> URL? {
        guard !docId.isEmpty else { return nil }
        let encoded = docId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? docId
        return URL(string: "/api/documents/\(encoded)/pdf", relativeTo: originURL)?.absoluteURL
    }

    /// Web dashboard URL for the Premium upgrade flow. Checkout itself is
    /// cookie-session based (`POST /billing/checkout` in
    /// `app/src/billing/routes.ts` reads the web session cookie, not the
    /// bearer token), so the app links out to the site's pricing modal
    /// instead of replaying that call.
    var upgradeURL: URL? {
        URL(string: "/", relativeTo: originURL)?.absoluteURL
    }

    /// Web dashboard URL for sharing/deep-link parity (`?trade=` / `?member=`).
    func shareURL(queryItem: URLQueryItem) -> URL? {
        var components = URLComponents(url: originURL, resolvingAgainstBaseURL: false)
        components?.path = "/"
        components?.queryItems = [queryItem]
        return components?.url
    }

    func bootstrap() async throws -> BootstrapResponse {
        try await get("bootstrap")
    }

    func feed(query: FeedQuery = .init()) async throws -> ClientFeedResponse {
        guard var components = URLComponents(url: endpointURL("feed"), resolvingAgainstBaseURL: false) else {
            throw APIError.invalidResponse
        }
        components.queryItems = query.queryItems
        guard let url = components.url else { throw APIError.invalidResponse }
        return try await request(url)
    }

    func member(id: String) async throws -> ClientMemberResponse {
        try await get("member/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)")
    }

    /// `GET /api/members` — the People directory roster. Origin-level, not
    /// under `/api/client/v1/*` (same pattern as `absoluteClientURL`'s other
    /// origin calls: `auth/*`, `documentPDFURL`, `logout`).
    func membersDirectory() async throws -> MemberDirectoryResponse {
        try await request(originURL.appendingPathComponent("api/members"))
    }

    /// `GET /api/assets` — the Assets directory roster (web parity: Directory
    /// tab's People|Assets segmented toggle, `app/src/ui/dashboardHtml.ts`
    /// `setDirectoryMode`/`loadAssetsDirectory`). Public, unauthenticated,
    /// no query params — the whole roster (every ticker that has ever
    /// appeared in a disclosed transaction), server-side 30-minute KV cache
    /// (`app/src/delivery/rest.ts` `queryAssetsRoster` / `r.get('/assets')`).
    /// Origin-level like `membersDirectory()`, not under `/api/client/v1/*`.
    func assetsDirectory() async throws -> AssetDirectoryResponse {
        try await request(originURL.appendingPathComponent("api/assets"))
    }

    func ticker(_ ticker: String) async throws -> ClientTickerResponse {
        let encoded = ticker.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ticker
        return try await get("ticker/\(encoded)")
    }

    /// Sends a magic-link sign-in email. The `client=ios` query makes the
    /// backend build a `congresstrade://auth` verify redirect
    /// (`app/src/auth/routes.ts` POST /auth/magic/request). Always resolves on
    /// the backend's anti-enumeration `ok:true` response.
    func requestMagicLink(email: String) async throws {
        guard var components = URLComponents(
            url: originURL.appendingPathComponent("auth/magic/request"),
            resolvingAgainstBaseURL: false
        ) else { throw APIError.invalidResponse }
        components.queryItems = [URLQueryItem(name: "client", value: "ios")]
        guard let url = components.url else { throw APIError.invalidResponse }
        var request = try makeRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["email": email], options: [])
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? decoder.decode(APIErrorResponse.self, from: data)
            let retryAfter = (http.value(forHTTPHeaderField: "Retry-After")).flatMap { Int($0) }
            throw APIError.server(status: http.statusCode, message: error?.error ?? "Could not send sign-in link", retryAfterSeconds: retryAfter)
        }
    }

    func subscriptions() async throws -> SubscriptionListResponse {
        try await get("subscriptions")
    }

    func preferences() async throws -> PreferencesResponse {
        try await get("preferences")
    }

    func latencySummary() async throws -> LatencySummary {
        try await analyticsGet("latency-summary")
    }

    private func makeQueryItems(window: String, party: String? = nil, chamber: String? = nil, extra: [URLQueryItem] = []) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "window", value: window)]
        if let party = party, !party.isEmpty { items.append(URLQueryItem(name: "party", value: party)) }
        if let chamber = chamber, !chamber.isEmpty { items.append(URLQueryItem(name: "chamber", value: chamber)) }
        items.append(contentsOf: extra)
        return items
    }

    func analyticsSummary(window: String, party: String? = nil, chamber: String? = nil) async throws -> AnalyticsSummary {
        try await analyticsGet("summary", query: makeQueryItems(window: window, party: party, chamber: chamber))
    }

    func tickerLeaderboard(window: String, party: String? = nil, chamber: String? = nil, rankBy: String = "volume") async throws -> TickerLeaderboardResponse {
        try await analyticsGet(
            "ticker-leaderboard",
            query: makeQueryItems(window: window, party: party, chamber: chamber, extra: [URLQueryItem(name: "rankBy", value: rankBy)])
        )
    }

    func volumeOverTime(window: String, party: String? = nil, chamber: String? = nil) async throws -> VolumeOverTimeResponse {
        try await analyticsGet("volume-over-time", query: makeQueryItems(window: window, party: party, chamber: chamber))
    }

    func sectorFlow(window: String, party: String? = nil, chamber: String? = nil) async throws -> SectorFlowResponse {
        try await analyticsGet("sector-flow", query: makeQueryItems(window: window, party: party, chamber: chamber))
    }

    func memberLeaderboard(window: String, party: String? = nil, chamber: String? = nil) async throws -> MemberLeaderboardResponse {
        try await analyticsGet("member-leaderboard", query: makeQueryItems(window: window, party: party, chamber: chamber))
    }

    func clusterBuys(window: String, party: String? = nil, chamber: String? = nil) async throws -> ClusterBuysResponse {
        try await analyticsGet("cluster-buys", query: makeQueryItems(window: window, party: party, chamber: chamber))
    }

    func trending(window: String, party: String? = nil, chamber: String? = nil) async throws -> TrendingResponse {
        try await analyticsGet("trending", query: makeQueryItems(window: window, party: party, chamber: chamber))
    }

    func topPerformers(window: String, party: String? = nil, chamber: String? = nil) async throws -> TopPerformersResponse {
        try await analyticsGet("member-performance", query: makeQueryItems(window: window, party: party, chamber: chamber))
    }

    func marketCapBreakdown(window: String, party: String? = nil, chamber: String? = nil) async throws -> MarketCapResponse {
        try await analyticsGet("market-cap-breakdown", query: makeQueryItems(window: window, party: party, chamber: chamber))
    }

    func partySplit(window: String, chamber: String? = nil) async throws -> PartySplitResponse {
        try await analyticsGet("party-split", query: makeQueryItems(window: window, chamber: chamber))
    }

    func filingLag(window: String, party: String? = nil, chamber: String? = nil) async throws -> FilingLagResponse {
        try await analyticsGet("filing-lag", query: makeQueryItems(window: window, party: party, chamber: chamber))
    }

    func conflicts(window: String, party: String? = nil, chamber: String? = nil) async throws -> ConflictCandidateResponse {
        try await analyticsGet("conflicts", query: makeQueryItems(window: window, party: party, chamber: chamber))
    }

    private func analyticsGet<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        guard var components = URLComponents(
            url: originURL.appendingPathComponent("api/analytics/\(path)"),
            resolvingAgainstBaseURL: false
        ) else { throw APIError.invalidResponse }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.invalidResponse }
        return try await request(url)
    }

    func commands(limit: Int = 20) async throws -> CommandListResponse {
        guard var components = URLComponents(url: endpointURL("commands"), resolvingAgainstBaseURL: false) else {
            throw APIError.invalidResponse
        }
        components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        guard let url = components.url else { throw APIError.invalidResponse }
        return try await request(url)
    }

    func command(id: String) async throws -> ClientCommandResponse<JSONValue> {
        try await get("commands/\(id)")
    }

    /// Confirms a previously cached trade is still live on the server.
    ///
    /// The feed and count queries silently exclude retracted ("deprecated")
    /// rows going forward — there is no tombstone/push signal for a row that
    /// was already synced to a device before an admin later un-published it
    /// (see `app/docs/client-mobile-api.md` "Chamber filter" section and
    /// `app/src/delivery/rows.ts`'s `t.deprecated_at IS NULL` filter). The one
    /// place the backend *does* signal this directly is `GET /trade/:id`,
    /// which 404s once a row is deprecated. Callers use that to reconcile an
    /// already-cached item on demand (e.g. when its detail view is opened).
    func tradeStillExists(id: String) async throws -> Bool {
        do {
            let _: Ack = try await get("trade/\(id)")
            return true
        } catch let error as APIError {
            if case .server(let status, _, _) = error, status == 404 {
                return false
            }
            throw error
        }
    }

    private struct Ack: Decodable {}

    func createSSESubscription(
        filters: SubscriptionFilters,
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<SubscriptionCommandResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "create_subscription",
                "payload": [
                    "delivery": "sse",
                    "filters": filters.commandPayload
                ]
            ]
        )
    }

    func createWebhookSubscription(
        targetURL: String,
        filters: SubscriptionFilters,
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<SubscriptionCommandResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "create_subscription",
                "payload": [
                    "delivery": "webhook",
                    "targetUrl": targetURL,
                    "filters": filters.commandPayload
                ]
            ]
        )
    }

    /// Register this device for backend-owned push alerts (`register_device`).
    /// Tokens are stored on the account; they do not consume SSE/webhook quota.
    /// Use a stable `idempotencyKey` (e.g. derived from the token) so refresh
    /// loops do not flood the async command queue.
    func registerDevice(
        apnsToken: String,
        appBundle: String = Bundle.main.bundleIdentifier ?? "trade.congress.ios",
        env: String = "production",
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<DeviceRegistrationResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "register_device",
                "payload": [
                    "platform": "apns",
                    "token": apnsToken,
                    "appBundle": appBundle,
                    "env": env
                ]
            ]
        )
    }

    /// Legacy name kept for call sites; prefers `register_device`.
    func createAPNsSubscription(
        apnsToken: String,
        filters: SubscriptionFilters = SubscriptionFilters(),
        idempotencyKey: String = UUID().uuidString
    ) async throws -> ClientCommandResponse<DeviceRegistrationResult> {
        try await registerDevice(apnsToken: apnsToken, idempotencyKey: idempotencyKey)
    }

    func updatePreferences(
        tickers: [String],
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<PreferencesCommandResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "update_preferences",
                "payload": [
                    "watchlist": tickers
                ]
            ]
        )
    }

    func setSubscriptionActive(
        id: String,
        active: Bool,
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<SubscriptionCommandResult> {
        return try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "update_subscription",
                "payload": ["id": id, "active": active]
            ]
        )
    }

    /// Hard-delete a delivery subscription (`delete_subscription` command).
    func deleteSubscription(
        id: String,
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<DeleteSubscriptionResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "delete_subscription",
                "payload": ["id": id]
            ]
        )
    }

    /// Premium CSV export (`GET /api/export/transactions.csv`). Accepts the
    /// same filters as the live feed; requires a Premium bearer session.
    func exportTransactionsCSV(
        from: String? = nil,
        to: String? = nil,
        ticker: String? = nil,
        memberName: String? = nil,
        chamber: String? = nil,
        type: String? = nil
    ) async throws -> Data {
        guard var components = URLComponents(
            url: originURL.appendingPathComponent("api/export/transactions.csv"),
            resolvingAgainstBaseURL: false
        ) else { throw APIError.invalidResponse }
        var items: [URLQueryItem] = []
        if let from, !from.isEmpty { items.append(URLQueryItem(name: "from", value: from)) }
        if let to, !to.isEmpty { items.append(URLQueryItem(name: "to", value: to)) }
        if let ticker, !ticker.isEmpty { items.append(URLQueryItem(name: "ticker", value: ticker)) }
        if let memberName, !memberName.isEmpty { items.append(URLQueryItem(name: "memberName", value: memberName)) }
        if let chamber, !chamber.isEmpty { items.append(URLQueryItem(name: "chamber", value: chamber)) }
        if let type, !type.isEmpty { items.append(URLQueryItem(name: "type", value: type)) }
        if !items.isEmpty { components.queryItems = items }
        guard let url = components.url else { throw APIError.invalidResponse }
        var request = try makeRequest(url)
        // Export can be large; give it a longer budget than interactive GETs.
        request.timeoutInterval = 60
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? decoder.decode(APIErrorResponse.self, from: data)
            let retryAfter = (http.value(forHTTPHeaderField: "Retry-After")).flatMap { Int($0) }
            throw APIError.server(
                status: http.statusCode,
                message: error?.error ?? "Export failed",
                retryAfterSeconds: retryAfter
            )
        }
        return data
    }

    /// Per-trade performance with an explicit timeout so slow tickers (e.g.
    /// thin history) cannot hang the detail sheet indefinitely.
    func tradePerformance(txId: String, timeout: TimeInterval = 12) async throws -> TradePerformanceResponse {
        let encoded = txId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? txId
        guard let components = URLComponents(
            url: originURL.appendingPathComponent("api/analytics/performance/\(encoded)"),
            resolvingAgainstBaseURL: false
        ), let url = components.url else {
            throw APIError.invalidResponse
        }
        var request = try makeRequest(url)
        request.timeoutInterval = timeout
        return try await send(request)
    }

    func logout() async throws {
        var request = try makeRequest(originURL.appendingPathComponent("auth/logout"))
        request.httpMethod = "POST"
        let (_, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.server(status: http.statusCode, message: "Could not revoke this session", retryAfterSeconds: nil)
        }
    }

    /// Native Sign in with Apple (`POST /auth/apple`). The client verifies
    /// nothing itself — it forwards `ASAuthorizationAppleIDCredential
    /// .identityToken` (UTF-8 decoded) as-is; the backend does full
    /// RS256-against-Apple's-JWKS verification before trusting any claim.
    /// `fullName` is only ever non-nil on the device's very first
    /// authorization for this app (Apple never encodes it in the token
    /// itself on later sign-ins). See `app/docs/client-mobile-api.md`.
    func signInWithApple(
        identityToken: String,
        nonce: String? = nil,
        fullName: String? = nil
    ) async throws -> AppleSignInResponse {
        var request = try makeRequest(originURL.appendingPathComponent("auth/apple"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body: [String: Any] = ["identityToken": identityToken]
        if let nonce, !nonce.isEmpty { body["nonce"] = nonce }
        if let fullName, !fullName.isEmpty { body["fullName"] = fullName }
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        return try await send(request)
    }

    /// Redeem a StoreKit 2 purchase (`redeem_apple_purchase` client command —
    /// `app/docs/client-mobile-api.md` "Apple In-App Purchase (StoreKit 2)").
    /// Not Premium-gated (this is how a signed-in user becomes Premium).
    /// Idempotent server-side on Apple's `originalTransactionId`, so both a
    /// fresh purchase and Restore Purchases call this the same way — pass a
    /// fresh `idempotencyKey` per call (command-layer idempotency is keyed on
    /// `userId + idempotencyKey`, distinct from the server's own
    /// transaction-id idempotency).
    func redeemApplePurchase(
        signedTransaction: String,
        idempotencyKey: String = UUID().uuidString
    ) async throws -> ClientCommandResponse<RedeemAppleResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "redeem_apple_purchase",
                "payload": ["signedTransaction": signedTransaction]
            ]
        )
    }

    /// Mints a short-lived Stripe-hosted Billing Portal URL for the
    /// signed-in user's Stripe customer (`POST /billing/portal`,
    /// `app/src/billing/routes.ts` — web parity; origin-level, not under
    /// `/api/client/v1/*`). Callers should treat any failure (401 not signed
    /// in, 503 portal not configured, 400 no Stripe customer yet, offline)
    /// as "show a helpful message" rather than falling back to the App Store
    /// URL — a Stripe subscriber has nothing to manage there.
    func billingPortalURL(idempotencyKey: String = UUID().uuidString) async throws -> URL {
        var request = try makeRequest(originURL.appendingPathComponent("billing/portal"))
        request.httpMethod = "POST"
        request.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key")
        let response: BillingPortalResponse = try await send(request)
        guard let url = URL(string: response.url) else {
            throw APIError.invalidResponse
        }
        return url
    }

    func absoluteClientURL(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        if let url = URL(string: value), url.scheme != nil {
            return url.absoluteString
        }
        return URL(string: value, relativeTo: originURL)?.absoluteURL.absoluteString
    }

    private var originURL: URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = ""
        components?.query = nil
        components?.fragment = nil
        // baseURL is validated at init (default or env-provided absolute URL),
        // so stripping the path always yields a valid origin; fall back to the
        // base itself rather than trapping if a future caller violates that.
        return components?.url ?? baseURL
    }

    private func endpointURL(_ path: String) -> URL {
        baseURL.appendingPathComponent(path)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await request(endpointURL(path))
    }

    private func postCommand<T: Decodable>(idempotencyKey: String, body: [String: Any]) async throws -> ClientCommandResponse<T> {
        var request = try makeRequest(endpointURL("commands"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        var response: ClientCommandResponse<T> = try await send(request)
        if response.command.status == .failed {
            throw APIError.server(status: 400, message: response.command.error ?? "Command failed", retryAfterSeconds: nil)
        }
        // POST /commands is async (202 + queued). Poll GET /commands/:id until
        // terminal — that first succeeded read also claims one-time secrets.
        if response.command.status == .queued || response.command.status == .running {
            response = try await awaitCommandResult(id: response.command.id)
        }
        if response.command.status == .failed {
            throw APIError.server(status: 400, message: response.command.error ?? "Command failed", retryAfterSeconds: nil)
        }
        if response.command.status == .canceled {
            throw APIError.server(status: 400, message: "Command was canceled", retryAfterSeconds: nil)
        }
        return response
    }

    /// Poll `GET /commands/:id` until the command leaves queued/running.
    /// The first authenticated succeeded read claims and returns `result_secret`.
    ///
    /// The server finishes most commands inline and answers POST /commands with
    /// a terminal status, so this loop is the fallback for the ones it hands
    /// back to the durable queue. That queue is drained by the background tick
    /// — a minute apart at best — so the budget here is ~77s, not the old ~18s.
    /// The old budget expired while a redeemed App Store purchase was still
    /// queued and reported it as an error to someone Apple had already charged.
    private func awaitCommandResult<T: Decodable>(id: String) async throws -> ClientCommandResponse<T> {
        let maxAttempts = 60
        for attempt in 0..<maxAttempts {
            if attempt > 0 {
                let delayNs: UInt64
                switch attempt {
                case ..<5: delayNs = 250_000_000
                case ..<13: delayNs = 500_000_000
                default: delayNs = 1_500_000_000
                }
                try await Task.sleep(nanoseconds: delayNs)
            }
            let polled: ClientCommandResponse<T> = try await get(
                "commands/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)"
            )
            switch polled.command.status {
            case .succeeded, .failed, .canceled:
                return polled
            case .queued, .running:
                continue
            }
        }
        throw APIError.server(
            status: 504,
            message: "Command is still running. Wait a moment, then retry if needed.",
            retryAfterSeconds: 2
        )
    }

    private func request<T: Decodable>(_ url: URL) async throws -> T {
        try await send(try makeRequest(url))
    }

    private func makeRequest(_ url: URL) throws -> URLRequest {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "accept")
        try interceptor.intercept(&request)
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? decoder.decode(APIErrorResponse.self, from: data)
            let retryAfter = (http.value(forHTTPHeaderField: "Retry-After")).flatMap { Int($0) }
            throw APIError.server(status: http.statusCode, message: error?.error ?? "Request failed", retryAfterSeconds: retryAfter)
        }
        return try decoder.decode(T.self, from: data)
    }

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as URLError {
            throw APIError.transport(error)
        }
    }
}

/// `GET /api/assets` response shape (`app/src/delivery/rest.ts`
/// `queryAssetsRoster`). No existing iOS Decodable matches this — asset rows
/// here are ticker-keyed roster entries, not `ClientTrade.asset`'s per-trade
/// snapshot in `Models.swift`.
struct AssetDirectoryResponse: Decodable {
    let assets: [AssetDirectoryEntry]
    let count: Int
}

struct AssetDirectoryEntry: Decodable, Identifiable, Hashable {
    let ticker: String
    /// LEFT-joined enrichment (`securities_ref`); `nil` for un-enriched tickers.
    let name: String?
    let assetClass: String?
    let txCount: Int?
    let memberCount: Int?

    var id: String { ticker }
}

struct APIErrorResponse: Decodable {
    let error: String
}

enum APIError: LocalizedError {
    case invalidResponse
    case server(status: Int, message: String, retryAfterSeconds: Int?)
    case transport(URLError)

    var isOffline: Bool {
        guard case .transport(let error) = self else { return false }
        return [
            .notConnectedToInternet,
            .networkConnectionLost,
            .cannotFindHost,
            .cannotConnectToHost,
            .dnsLookupFailed
        ].contains(error.code)
    }

    /// True when the underlying URLSession task was cancelled (view dismiss,
    /// Task cancel, or refresh superseded). Callers must not surface these as
    /// feed/trends error banners.
    var isCancellation: Bool {
        if case .transport(let error) = self {
            return error.code == .cancelled
        }
        return false
    }

    /// Whether a retry is worth attempting: rate limiting (429), transient
    /// server failure (5xx), or a transport-level hiccup. Anything else
    /// (400/401/404/etc.) is a permanent rejection that retrying cannot fix.
    /// Cancellation is never retryable.
    var isRetryable: Bool {
        if isCancellation { return false }
        switch self {
        case .server(let status, _, _):
            return status == 429 || (500...599).contains(status)
        case .transport:
            return true
        case .invalidResponse:
            return false
        }
    }

    /// Server-provided `Retry-After` (seconds), when present on a 429/5xx.
    var retryAfterSeconds: Int? {
        guard case .server(_, _, let retryAfterSeconds) = self else { return nil }
        return retryAfterSeconds
    }

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid server response."
        case .server(_, let message, _):
            return message
        case .transport(let error):
            return error.localizedDescription
        }
    }
}
