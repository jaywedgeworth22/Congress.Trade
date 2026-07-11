import Foundation
import XCTest
@testable import CongressTrade

final class CongressTradeTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    func testParseTickersNormalizesAndDropsEmptyValues() async {
        let tickers = await CongressTradeStore.parseTickers(" aapl, MSFT, , nvda \n")
        XCTAssertEqual(tickers, ["AAPL", "MSFT", "NVDA"])
    }

    func testActiveOnlySubscriptionCommandPreservesFilters() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: "native-session"),
            session: session
        )
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "intent-123")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer native-session")
            let body = try XCTUnwrap(request.httpBody)
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            let payload = try XCTUnwrap(json["payload"] as? [String: Any])
            XCTAssertEqual(payload["id"] as? String, "sub_1")
            XCTAssertEqual(payload["active"] as? Bool, false)
            XCTAssertNil(payload["filters"], "Pause/resume must not replace the subscription filters")
            return Self.response(
                for: request,
                json: """
                {
                  "command": {
                    "id": "cmd_1", "userId": "user_1", "type": "update_subscription",
                    "status": "succeeded", "idempotencyKey": "intent-123", "error": null,
                    "createdAt": "2026-07-11T00:00:00Z", "updatedAt": "2026-07-11T00:00:00Z",
                    "startedAt": "2026-07-11T00:00:00Z", "finishedAt": "2026-07-11T00:00:01Z"
                  },
                  "result": { "subscription": {
                    "id": "sub_1", "delivery": "sse", "targetUrl": null,
                    "filters": { "tickers": ["AAPL"] }, "cursor": 0, "active": false,
                    "createdAt": "2026-07-11T00:00:00Z", "hasSecret": true
                  }}
                }
                """
            )
        }

        let result = try await client.setSubscriptionActive(
            id: "sub_1",
            active: false,
            idempotencyKey: "intent-123"
        )
        XCTAssertEqual(result.result?.subscription.filters.tickers, ["AAPL"])
        XCTAssertFalse(try XCTUnwrap(result.result?.subscription.active))
    }

    func testPreferencesLoadUsesServerWatchlist() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: nil),
            session: session
        )
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/client/v1/preferences")
            return Self.response(
                for: request,
                json: """
                {"preferences": {
                  "userId": "user_1", "savedFilters": {}, "watchlist": ["TSLA", "AMD"],
                  "notificationSettings": {}, "defaultWindow": "all",
                  "updatedAt": "2026-07-11T00:00:00Z"
                }}
                """
            )
        }

        let response = try await client.preferences()
        XCTAssertEqual(response.preferences.watchlist, ["TSLA", "AMD"])
    }

    func testRelativeStreamURLResolvesAgainstAPIOrigin() {
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: nil)
        )
        XCTAssertEqual(
            client.absoluteClientURL("/api/stream?subscription=sub_1&token=secret"),
            "https://example.test/api/stream?subscription=sub_1&token=secret"
        )

        let localClient = CongressTradeAPIClient(
            baseURL: URL(string: "http://127.0.0.1:8787/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: nil)
        )
        XCTAssertEqual(
            localClient.absoluteClientURL("/api/stream?subscription=sub_1"),
            "http://127.0.0.1:8787/api/stream?subscription=sub_1"
        )
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static func response(for request: URLRequest, json: String) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["content-type": "application/json"]
        )!
        return (response, Data(json.utf8))
    }
}

private final class MemoryTokenStore: SessionTokenStore {
    private var token: String?

    init(token: String?) {
        self.token = token
    }

    func load() throws -> String? { token }
    func save(_ token: String) throws { self.token = token }
    func clear() throws { token = nil }
}

private final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let (response, data) = try XCTUnwrap(Self.handler)(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
