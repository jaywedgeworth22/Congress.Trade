import Foundation

protocol SessionTokenStore {
    func load() throws -> String?
    func save(_ token: String) throws
    func clear() throws
}

final class CongressTradeAPI: ObservableObject {
    private let baseURL: URL
    private let tokenStore: SessionTokenStore
    private let session: URLSession
    private let decoder = JSONDecoder()

    init(
        baseURL: URL = URL(string: "https://congress.trade/api/client/v1")!,
        tokenStore: SessionTokenStore,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.tokenStore = tokenStore
        self.session = session
    }

    func bootstrap() async throws -> BootstrapResponse {
        try await get("bootstrap")
    }

    func feed(limit: Int = 50, since: Int? = nil) async throws -> ClientFeedResponse {
        var components = URLComponents(url: baseURL.appending(path: "feed"), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let since { items.append(URLQueryItem(name: "since", value: String(since))) }
        components.queryItems = items
        return try await request(components.url!)
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

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await request(baseURL.appending(path: path))
    }

    private func postCommand<T: Decodable>(idempotencyKey: String, body: [String: Any]) async throws -> T {
        let url = baseURL.appending(path: "commands")
        var request = try makeRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    private func request<T: Decodable>(_ url: URL) async throws -> T {
        try await send(try makeRequest(url))
    }

    private func makeRequest(_ url: URL) throws -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if let token = try tokenStore.load() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
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
