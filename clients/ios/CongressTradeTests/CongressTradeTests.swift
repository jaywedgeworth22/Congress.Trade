import Foundation
import SwiftData
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

    // MARK: - SubscriptionFilters Codable round-trip (item 4)

    func testSubscriptionFiltersRoundTripsAllDocumentedFields() throws {
        let filters = SubscriptionFilters(
            members: ["B000944"],
            tickers: ["AAPL"],
            chambers: ["house", "senate"],
            minAmount: 1001,
            maxAmount: 50000,
            sides: ["P"],
            sectors: ["Technology"],
            marketCapBuckets: ["mega", "large"]
        )
        let data = try JSONEncoder().encode(filters)
        let decoded = try JSONDecoder().decode(SubscriptionFilters.self, from: data)
        XCTAssertEqual(decoded, filters, "Every documented SubscriptionFilters field must survive an encode/decode round trip")
    }

    func testSubscriptionFiltersDecodeDoesNotDropBackendOnlyFields() throws {
        // A subscription created elsewhere (e.g. the web/PWA client) with the
        // full filter set the backend documents in app/src/shared/types.ts.
        let json = """
        {"members":["B000944"],"tickers":["AAPL"],"chambers":["house"],
         "minAmount":1001,"maxAmount":50000,"sides":["P"],
         "sectors":["Technology"],"marketCapBuckets":["mega","large"]}
        """
        let decoded = try JSONDecoder().decode(SubscriptionFilters.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.maxAmount, 50000)
        XCTAssertEqual(decoded.sides, ["P"])
        XCTAssertEqual(decoded.sectors, ["Technology"])
        XCTAssertEqual(decoded.marketCapBuckets, ["mega", "large"])
    }

    // MARK: - Chamber filter honesty (item CT-AUD-010)

    @MainActor
    func testDefaultChamberSelectionMatchesBackendDefaultAndOmitsTheParam() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        XCTAssertEqual(store.selectedChambers, [.house, .senate, .executive])

        var feedURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            feedURL = request.url
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        await store.setChamberSelection([.house, .senate])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURL), resolvingAgainstBaseURL: false))
        XCTAssertNil(
            components.queryItems?.first(where: { $0.name == "chamber" }),
            "Default selection must omit chamber= entirely so unresolved-chamber rows stay in view, matching the backend's absent-chamber default"
        )
    }

    @MainActor
    func testWidenedChamberSelectionSendsOneCanonicalSortedList() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        var feedURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            feedURL = request.url
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        // Selecting the chips in an arbitrary order must not change the wire value.
        await store.setChamberSelection([.executive, .house, .senate])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURL), resolvingAgainstBaseURL: false))
        let chamberValue = components.queryItems?.first(where: { $0.name == "chamber" })?.value
        XCTAssertEqual(chamberValue, "executive,house,senate")
    }

    @MainActor
    func testDeselectingTheLastChamberChipResetsToTheDefault() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        await store.setChamberSelection([])

        XCTAssertEqual(store.selectedChambers, [.house, .senate, .executive])
    }

    // MARK: - Feed catch-up sync (CT-AUD-009)

    @MainActor
    func testCatchUpLoopPagesForwardUntilAShortPageSignalsExhaustion() async throws {
        let cursorStore = InMemorySyncCursorStore()
        cursorStore.setCursor(100, for: "house,senate")
        var feedCallCount = 0
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            feedCallCount += 1
            switch feedCallCount {
            case 1:
                return Self.response(for: request, json: Self.feedJSON(
                    items: (1...50).map { Self.tradeJSON(id: "a\($0)", cursor: 100 + $0) },
                    cursor: 150, count: 50, total: 500, limit: 50
                ))
            case 2:
                return Self.response(for: request, json: Self.feedJSON(
                    items: (1...50).map { Self.tradeJSON(id: "b\($0)", cursor: 150 + $0) },
                    cursor: 200, count: 50, total: 500, limit: 50
                ))
            default:
                return Self.response(for: request, json: Self.feedJSON(
                    items: (1...10).map { Self.tradeJSON(id: "c\($0)", cursor: 200 + $0) },
                    cursor: 210, count: 10, total: 500, limit: 50
                ))
            }
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: cursorStore,
            sleeper: { _ in }
        )
        await store.setChamberSelection([.house, .senate])

        XCTAssertEqual(feedCallCount, 3, "Should keep paging while pages are full, stopping only once a short page signals exhaustion")
        XCTAssertEqual(cursorStore.cursor(for: "house,senate"), 210)
        XCTAssertNil(store.feedNotice)
    }

    @MainActor
    func testCatchUpLoopStopsAtTheBoundedPageCapAndSurfacesANotice() async throws {
        let cursorStore = InMemorySyncCursorStore()
        cursorStore.setCursor(1000, for: "house,senate")
        var feedCallCount = 0
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            feedCallCount += 1
            let base = 1000 + (feedCallCount - 1) * 50
            return Self.response(for: request, json: Self.feedJSON(
                items: (1...50).map { Self.tradeJSON(id: "p\(feedCallCount)_\($0)", cursor: base + $0) },
                cursor: base + 50, count: 50, total: 100_000, limit: 50
            ))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: cursorStore,
            sleeper: { _ in }
        )
        await store.setChamberSelection([.house, .senate])

        XCTAssertEqual(feedCallCount, 20, "A very large backlog must not turn one refresh into an unbounded crawl")
        XCTAssertEqual(store.feedNotice, "Caught up on the latest 1000 trades. Pull to refresh again to keep catching up.")
    }

    @MainActor
    func testTransientServerErrorIsRetriedWithBackoffThenSucceeds() async throws {
        var feedAttempts = 0
        var recordedDelays: [Double] = []
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            feedAttempts += 1
            if feedAttempts == 1 {
                let response = HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: [:])!
                return (response, Data("{\"error\":\"try again\"}".utf8))
            }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { seconds in recordedDelays.append(seconds) }
        )
        await store.refresh()

        XCTAssertEqual(feedAttempts, 2, "A transient 503 should be retried once before succeeding")
        XCTAssertEqual(recordedDelays.count, 1)
        XCTAssertNil(store.feedNotice)
    }

    @MainActor
    func testPermanentClientErrorIsNotRetried() async throws {
        var feedAttempts = 0
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            feedAttempts += 1
            let response = HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: [:])!
            return (response, Data("{\"error\":\"bad request\"}".utf8))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in XCTFail("A permanent 4xx must not trigger a backoff sleep") }
        )
        await store.refresh()

        XCTAssertEqual(feedAttempts, 1)
        XCTAssertEqual(store.feedNotice, "bad request")
    }

    // MARK: - Deprecated-row reconciliation (CT-AUD-009)

    @MainActor
    func testReconcileIfDeprecatedRemovesA404TradeFromTheLocalCache() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertTrue(request.url?.path.hasSuffix("/trade/tx_1") == true)
            let response = HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: [:])!
            return (response, Data("{\"error\":\"trade not found\"}".utf8))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let context = try Self.makeInMemoryModelContext()
        store.modelContext = context
        let trade = Self.makeTrade(id: "tx_1", cursor: 1)
        context.insert(trade)
        try context.save()

        let removed = await store.reconcileIfDeprecated(trade)

        XCTAssertTrue(removed)
        XCTAssertNotNil(store.feedNotice)
        XCTAssertTrue(try context.fetch(FetchDescriptor<ClientTrade>()).isEmpty)
    }

    @MainActor
    func testReconcileIfDeprecatedLeavesAStillLiveTradeCached() async throws {
        MockURLProtocol.handler = { request in
            Self.response(for: request, json: "{}")
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let context = try Self.makeInMemoryModelContext()
        store.modelContext = context
        let trade = Self.makeTrade(id: "tx_1", cursor: 1)
        context.insert(trade)
        try context.save()

        let removed = await store.reconcileIfDeprecated(trade)

        XCTAssertFalse(removed)
        XCTAssertEqual(try context.fetch(FetchDescriptor<ClientTrade>()).count, 1)
    }

    // MARK: - Test helpers

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static let baseURL = URL(string: "https://example.test/api/client/v1")!

    private static let bootstrapJSON = """
    {"serverTime":"2026-07-18T00:00:00Z","auth":{"user":null,"entitlement":{"premium":false,"status":null,"plan":null}},
     "capabilities":{},"endpoints":{}}
    """

    private static func feedJSON(items: [String], cursor: Int, count: Int, total: Int, limit: Int) -> String {
        "{\"items\":[\(items.joined(separator: ","))],\"cursor\":\(cursor),\"count\":\(count),\"total\":\(total),\"limit\":\(limit),\"nextPollAfterSec\":30}"
    }

    private static func tradeJSON(id: String, cursor: Int) -> String {
        """
        {"id":"\(id)","cursor":\(cursor),"docId":"doc_\(id)","member":{},
         "asset":{"name":"Acme Corp"},"transaction":{"type":"P","isOption":false},
         "filing":{},"confidence":0.9,"source":"primary"}
        """
    }

    @MainActor
    private static func makeInMemoryModelContext() throws -> ModelContext {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: ClientTrade.self, configurations: configuration)
        return ModelContext(container)
    }

    private static func makeTrade(id: String, cursor: Int) -> ClientTrade {
        ClientTrade(
            id: id,
            cursor: cursor,
            docId: "doc_\(id)",
            member: .init(id: nil, name: nil, chamber: nil, party: nil, state: nil, photoUrl: nil),
            asset: .init(name: "Acme Corp", ticker: nil, type: nil, sector: nil, marketCapBucket: nil),
            transaction: .init(date: nil, type: "P", owner: nil, amountMin: nil, amountMax: nil, isOption: false),
            filing: .init(filedDate: nil, firstSeenAt: nil, sourceUrl: nil),
            confidence: 0.9,
            source: .primary
        )
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

private final class InMemorySyncCursorStore: SyncCursorStore {
    private var values: [String: Int] = [:]

    func cursor(for key: String) -> Int? { values[key] }
    func setCursor(_ cursor: Int, for key: String) { values[key] = cursor }
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
