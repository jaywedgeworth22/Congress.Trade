import Foundation

protocol SessionTokenStore {
    func load() throws -> String?
    func save(_ token: String) throws
    func clear() throws
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
        return URL(string: "https://congress.trade/api/client/v1")!
    }

    func bootstrap() async throws -> BootstrapResponse {
        try await get("bootstrap")
    }

    func feed(query: FeedQuery = .init()) async throws -> ClientFeedResponse {
        var components = URLComponents(url: endpointURL("feed"), resolvingAgainstBaseURL: false)!
        components.queryItems = query.queryItems
        return try await request(components.url!)
    }

    func subscriptions() async throws -> SubscriptionListResponse {
        try await get("subscriptions")
    }

    func preferences() async throws -> PreferencesResponse {
        try await get("preferences")
    }

    func commands(limit: Int = 20) async throws -> CommandListResponse {
        var components = URLComponents(url: endpointURL("commands"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        return try await request(components.url!)
    }

    func command(id: String) async throws -> ClientCommandResponse<JSONValue> {
        try await get("commands/\(id)")
    }

    func createSSESubscription(
        tickers: [String],
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<SubscriptionCommandResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "create_subscription",
                "payload": [
                    "delivery": "sse",
                    "filters": ["tickers": tickers]
                ]
            ]
        )
    }

    func createWebhookSubscription(
        targetURL: String,
        tickers: [String],
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<SubscriptionCommandResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "create_subscription",
                "payload": [
                    "delivery": "webhook",
                    "targetUrl": targetURL,
                    "filters": ["tickers": tickers]
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
            throw APIError.server(status: http.statusCode, message: "Could not revoke this session")
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
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url!
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
            throw APIError.server(status: 400, message: response.command.error ?? "Command failed")
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
            throw APIError.server(status: http.statusCode, message: error?.error ?? "Request failed")
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
    case server(status: Int, message: String)
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

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid server response."
        case .server(_, let message):
            return message
        case .transport(let error):
            return error.localizedDescription
        }
    }
}
