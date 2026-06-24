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

final class CongressTradeAPIClient {
    private let baseURL: URL
    private let tokenStore: SessionTokenStore
    private let session: URLSession
    private let decoder: JSONDecoder

    init(
        baseURL: URL = CongressTradeAPIClient.defaultBaseURL,
        tokenStore: SessionTokenStore = KeychainTokenStore(),
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.tokenStore = tokenStore
        self.session = session
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

    func commands(limit: Int = 20) async throws -> CommandListResponse {
        var components = URLComponents(url: endpointURL("commands"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        return try await request(components.url!)
    }

    func command(id: String) async throws -> ClientCommandResponse<JSONValue> {
        try await get("commands/\(id)")
    }

    func createSSESubscription(tickers: [String]) async throws -> ClientCommandResponse<SubscriptionCommandResult> {
        try await postCommand(
            idempotencyKey: "ios-sse-\(tickers.map { $0.uppercased() }.joined(separator: "-"))",
            body: [
                "type": "create_subscription",
                "payload": [
                    "delivery": "sse",
                    "filters": ["tickers": tickers]
                ]
            ]
        )
    }

    func createWebhookSubscription(targetURL: String, tickers: [String]) async throws -> ClientCommandResponse<SubscriptionCommandResult> {
        try await postCommand(
            idempotencyKey: "ios-webhook-\(targetURL)",
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

    func updatePreferences(tickers: [String]) async throws -> ClientCommandResponse<JSONValue> {
        try await postCommand(
            idempotencyKey: "ios-prefs-\(tickers.map { $0.uppercased() }.joined(separator: "-"))",
            body: [
                "type": "update_preferences",
                "payload": [
                    "watchlist": tickers,
                    "defaultWindow": "all"
                ]
            ]
        )
    }

    func updateSubscription(
        id: String,
        active: Bool?,
        targetURL: String?,
        tickers: [String]
    ) async throws -> ClientCommandResponse<SubscriptionCommandResult> {
        var payload: [String: Any] = ["id": id]
        if let active {
            payload["active"] = active
        }
        if let targetURL {
            payload["targetUrl"] = targetURL
        }
        payload["filters"] = ["tickers": tickers]
        return try await postCommand(
            idempotencyKey: "ios-update-\(id)-\(active.map(String.init) ?? "noop")-\(tickers.joined(separator: "-"))",
            body: [
                "type": "update_subscription",
                "payload": payload
            ]
        )
    }

    private func endpointURL(_ path: String) -> URL {
        baseURL.appendingPathComponent(path)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await request(endpointURL(path))
    }

    private func postCommand<T: Decodable>(idempotencyKey: String, body: [String: Any]) async throws -> T {
        var request = try makeRequest(endpointURL("commands"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        return try await send(request)
    }

    private func request<T: Decodable>(_ url: URL) async throws -> T {
        try await send(try makeRequest(url))
    }

    private func makeRequest(_ url: URL) throws -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if let token = try tokenStore.load() {
            let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                request.setValue("Bearer \(trimmed)", forHTTPHeaderField: "authorization")
            }
        }
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? decoder.decode(APIErrorResponse.self, from: data)
            throw APIError.server(status: http.statusCode, message: error?.error ?? "Request failed")
        }
        return try decoder.decode(T.self, from: data)
    }
}

struct APIErrorResponse: Decodable {
    let error: String
}

enum APIError: LocalizedError {
    case invalidResponse
    case server(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid server response."
        case .server(_, let message):
            return message
        }
    }
}
