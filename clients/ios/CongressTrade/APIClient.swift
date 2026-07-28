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
    var member: String?
    var chamber: String?
    var type: String?
    var from: String?
    var to: String?
    /// Backend sort key: `tx_date` | `published` | cursor (default). Prefer
    /// `tx_date` for the consumer feed so seed imports of old filings don't
    /// float to the top just because they got a high cursor_seq.
    var sort: String?
    var order: String?

    var queryItems: [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let since { items.append(URLQueryItem(name: "since", value: String(since))) }
        if let ticker, !ticker.isEmpty { items.append(URLQueryItem(name: "ticker", value: ticker)) }
        if let member, !member.isEmpty { items.append(URLQueryItem(name: "member", value: member)) }
        if let chamber, !chamber.isEmpty { items.append(URLQueryItem(name: "chamber", value: chamber)) }
        if let type, !type.isEmpty { items.append(URLQueryItem(name: "type", value: type)) }
        if let from, !from.isEmpty { items.append(URLQueryItem(name: "from", value: from)) }
        if let to, !to.isEmpty { items.append(URLQueryItem(name: "to", value: to)) }
        if let sort, !sort.isEmpty { items.append(URLQueryItem(name: "sort", value: sort)) }
        if let order, !order.isEmpty { items.append(URLQueryItem(name: "order", value: order)) }
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

    func analyticsSummary(window: String) async throws -> AnalyticsSummary {
        try await analyticsGet("summary", query: [URLQueryItem(name: "window", value: window)])
    }

    func tickerLeaderboard(window: String, rankBy: String = "volume") async throws -> TickerLeaderboardResponse {
        try await analyticsGet(
            "ticker-leaderboard",
            query: [
                URLQueryItem(name: "window", value: window),
                URLQueryItem(name: "rankBy", value: rankBy),
            ]
        )
    }

    func volumeOverTime(window: String) async throws -> VolumeOverTimeResponse {
        try await analyticsGet("volume-over-time", query: [URLQueryItem(name: "window", value: window)])
    }

    func sectorFlow(window: String) async throws -> SectorFlowResponse {
        try await analyticsGet("sector-flow", query: [URLQueryItem(name: "window", value: window)])
    }

    func memberLeaderboard(window: String) async throws -> MemberLeaderboardResponse {
        try await analyticsGet("member-leaderboard", query: [URLQueryItem(name: "window", value: window)])
    }

    func clusterBuys(window: String) async throws -> ClusterBuysResponse {
        try await analyticsGet("cluster-buys", query: [URLQueryItem(name: "window", value: window)])
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
        let response: ClientCommandResponse<T> = try await send(request)
        if response.command.status == .failed {
            throw APIError.server(status: 400, message: response.command.error ?? "Command failed", retryAfterSeconds: nil)
        }
        return response
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

    /// Whether a retry is worth attempting: rate limiting (429), transient
    /// server failure (5xx), or a transport-level hiccup. Anything else
    /// (400/401/404/etc.) is a permanent rejection that retrying cannot fix.
    var isRetryable: Bool {
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
