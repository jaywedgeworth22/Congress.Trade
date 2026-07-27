import Foundation
import SwiftData

struct BootstrapResponse: Decodable {
    let serverTime: String
    let auth: Auth
    let capabilities: [String: Bool]
    let endpoints: [String: String]

    struct Auth: Decodable {
        let user: User?
        let entitlement: Entitlement
    }
}
struct User: Decodable {
    let id: String
    let email: String
    let name: String?
    let picture: String?
}

struct Entitlement: Decodable {
    let premium: Bool
    let status: String?
    let plan: String?
}

struct ClientFeedResponse: Decodable {
    let items: [ClientTrade]
    let cursor: Int
    let count: Int
    let total: Int
    let limit: Int
    let nextPollAfterSec: Int
}

@Model
final class ClientTrade: Decodable, Identifiable {
    @Attribute(.unique) var id: String
    var cursor: Int
    var docId: String
    var member: Member
    var asset: Asset
    var transaction: Transaction
    var filing: Filing
    var confidence: Double
    var source: Source

    enum Source: String, Codable {
        case primary
        case seedDataset = "seed_dataset"
        case competitorBackfill = "competitor_backfill"
    }

    struct Member: Codable {
        var id: String?
        var name: String?
        var chamber: String?
        var party: String?
        var state: String?
        var photoUrl: String?
    }

    struct Asset: Codable {
        var name: String
        var ticker: String?
        var type: String?
        var sector: String?
        var marketCapBucket: String?
    }

    struct Transaction: Codable {
        var date: String?
        var type: String
        var owner: String?
        var amountMin: Int?
        var amountMax: Int?
        var isOption: Bool
    }

    struct Filing: Codable {
        var filedDate: String?
        var firstSeenAt: String?
        var sourceUrl: String?
    }

    init(id: String, cursor: Int, docId: String, member: Member, asset: Asset, transaction: Transaction, filing: Filing, confidence: Double, source: Source) {
        self.id = id
        self.cursor = cursor
        self.docId = docId
        self.member = member
        self.asset = asset
        self.transaction = transaction
        self.filing = filing
        self.confidence = confidence
        self.source = source
    }

    required init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.cursor = try container.decode(Int.self, forKey: .cursor)
        self.docId = try container.decode(String.self, forKey: .docId)
        self.member = try container.decode(Member.self, forKey: .member)
        self.asset = try container.decode(Asset.self, forKey: .asset)
        self.transaction = try container.decode(Transaction.self, forKey: .transaction)
        self.filing = try container.decode(Filing.self, forKey: .filing)
        self.confidence = try container.decode(Double.self, forKey: .confidence)
        self.source = try container.decode(Source.self, forKey: .source)
    }

    enum CodingKeys: String, CodingKey {
        case id, cursor, docId, member, asset, transaction, filing, confidence, source
    }
}

struct ClientMemberResponse: Decodable {
    let member: ClientTrade.Member
    let summary: MemberSummary
    let items: [ClientTrade]
    
    struct MemberSummary: Decodable {
        let totalTrades: Int?
        let buyCount: Int?
        let sellCount: Int?
        let exchangeCount: Int?
        let estimatedVolumeUsd: Double?
        let estimatedNetFlowUsd: Double?
        let firstTrade: String?
        let lastTrade: String?
        let uniqueTickers: Int?
        let uniqueAssets: Int?
        let performance: MemberPerformance?
    }
    
    struct MemberPerformance: Decodable {
        let tradeCount: Int
        let scoredCount: Int
        let winRate: Double?
        let medianReturn: Double?
        let medianExcess: Double?
        let avgReturn: Double?
        let avgExcess: Double?
    }
}

struct SubscriptionListResponse: Decodable {
    let subscriptions: [Subscription]
}

struct PreferencesResponse: Decodable {
    let preferences: ClientPreferences
}

struct ClientPreferences: Decodable, Equatable {
    let userId: String
    let savedFilters: [String: JSONValue]
    let watchlist: [String]
    let notificationSettings: [String: JSONValue]
    let defaultWindow: String?
    let updatedAt: String
}

struct CommandListResponse: Decodable {
    let commands: [ClientCommand]
}

/// Mirrors the backend's `SubscriptionFilters` contract 1:1
/// (`app/src/shared/types.ts`). All fields are optional/undefined => "all";
/// keep this struct's field set in lock-step with the backend so decoding an
/// existing subscription's filters (`GET /subscriptions`) never silently
/// drops a documented field before it can be redisplayed or re-encoded.
struct SubscriptionFilters: Codable, Hashable {
    var members: [String]?
    var tickers: [String]?
    var chambers: [String]?
    /// Minimum transaction amount_min (bracket floor) to deliver.
    var minAmount: Int?
    /// Maximum transaction amount_min (bracket floor); pairs with minAmount for a range.
    var maxAmount: Int?
    /// Transaction sides to include, e.g. ["P"] for buys only.
    var sides: [String]?
    /// GICS sectors to include (securities_ref.sector).
    var sectors: [String]?
    /// Market-cap buckets to include (mega...nano, securities_ref.market_cap_bucket).
    var marketCapBuckets: [String]?
}

/// Canonical chamber chip selection. One set drives both the visible chips
/// and the `chamber=` request parameter (CT-AUD-010) — there is no separate
/// "what the UI shows" vs "what was requested" state.
enum ChamberFilter: String, CaseIterable, Codable, Hashable, Identifiable {
    case house
    case senate
    case executive

    var id: String { rawValue }

    var label: String {
        switch self {
        case .house: return "House"
        case .senate: return "Senate"
        case .executive: return "Executive"
        }
    }

    /// Website-parity single-letter chips (H / S / P).
    var shortLabel: String {
        switch self {
        case .house: return "H"
        case .senate: return "S"
        case .executive: return "P"
        }
    }
}

struct ClientCommandResponse<ResultPayload: Decodable>: Decodable {
    let command: ClientCommand
    let result: ResultPayload?
    let replayed: Bool?
    let error: String?
}

struct ClientCommand: Decodable, Identifiable {
    let id: String
    let userId: String
    let type: String
    let status: Status
    let idempotencyKey: String?
    let error: String?
    let createdAt: String
    let updatedAt: String
    let startedAt: String?
    let finishedAt: String?

    enum Status: String, Decodable {
        case queued
        case running
        case succeeded
        case failed
        case canceled
    }
}

struct SubscriptionCommandResult: Decodable {
    let subscription: Subscription
}

struct PreferencesCommandResult: Decodable {
    let preferences: ClientPreferences
}

struct Subscription: Decodable, Identifiable {
    let id: String
    let delivery: String
    let targetUrl: String?
    let filters: SubscriptionFilters
    let cursor: Int
    let active: Bool
    let createdAt: String
    let hasSecret: Bool
    let secret: String?
    let streamUrl: String?
}

struct DeliveryCredential: Identifiable, Equatable {
    let id: String
    let delivery: String
    let streamURL: String?
    let secret: String?
}

enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let int = try? container.decode(Int.self) {
            self = .number(Double(int))
        } else if let double = try? container.decode(Double.self) {
            self = .number(double)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else if let object = try? container.decode([String: JSONValue].self) {
            self = .object(object)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let string):
            try container.encode(string)
        case .number(let number):
            try container.encode(number)
        case .bool(let bool):
            try container.encode(bool)
        case .object(let object):
            try container.encode(object)
        case .array(let array):
            try container.encode(array)
        case .null:
            try container.encodeNil()
        }
    }

    var prettyPrinted: String {
        let payload = foundationValue
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: data, encoding: .utf8)
        else {
            return String(describing: payload)
        }
        return string
    }

    private var foundationValue: Any {
        switch self {
        case .string(let string):
            return string
        case .number(let number):
            return number
        case .bool(let bool):
            return bool
        case .object(let object):
            return object.mapValues { $0.foundationValue }
        case .array(let array):
            return array.map { $0.foundationValue }
        case .null:
            return NSNull()
        }
    }
}

enum TradeSearch {
    static func matches(_ trade: ClientTrade, normalizedNeedle: String) -> Bool {
        [
            trade.asset.ticker,
            trade.asset.name,
            trade.member.name,
            trade.member.state,
            trade.member.chamber
        ].contains { ($0 ?? "").lowercased().contains(normalizedNeedle) }
    }
}

struct LatencyProvider: Decodable, Identifiable {
    let id: String
    let label: String
    let candidates: Int
    let matched: Int
    let coveragePct: Double
    let usFirstCount: Int
    let providerFirstCount: Int
    let tieCount: Int
    let medianLeadSec: Int?
    let avgLeadSec: Int?
    let p90LeadSec: Int?
}

struct LatencySummary: Decodable {
    let generatedAt: String
    let totals: LatencyTotals
    let providers: [LatencyProvider]
    
    struct LatencyTotals: Decodable {
        let racedDisclosures: Int
        let matched: Int
        let pending: Int
        let comparableProviders: Int
    }
}

/// Consumer time windows matching the website's Trends/Trades selector
/// (`app/src/ui/dashboardHtml.ts` TR_WINDOW_LABELS / default `90d`).
enum TimeRange: String, CaseIterable, Identifiable, Codable {
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case ninetyDays = "90d"
    case sixMonths = "180d"
    case oneYear = "365d"
    case all = "all"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .sevenDays: return "Past Week"
        case .thirtyDays: return "Past Month"
        case .ninetyDays: return "Past 3 Months"
        case .sixMonths: return "Past 6 Months"
        case .oneYear: return "Past Year"
        case .all: return "All Time"
        }
    }

    /// ISO `yyyy-MM-dd` lower bound for `?from=` on the feed, or `nil` for all-time.
    var fromDateISO: String? {
        guard self != .all else { return nil }
        let days: Int
        switch self {
        case .sevenDays: days = 7
        case .thirtyDays: days = 30
        case .ninetyDays: days = 90
        case .sixMonths: days = 180
        case .oneYear: days = 365
        case .all: return nil
        }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let date = cal.date(byAdding: .day, value: -days, to: Date()) else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}

struct AnalyticsSummary: Decodable {
    let totalTrades: Int?
    let uniqueMembers: Int?
    let uniqueTickers: Int?
    let buyCount: Int?
    let sellCount: Int?
    let exchangeCount: Int?
    let estimatedVolumeUsd: Double?
    let estimatedNetFlowUsd: Double?
    let optionCount: Int?
    let resolvedTickerPct: Double?
    let netSentiment: Double?
    let asOf: String?
}

struct TickerLeaderboardResponse: Decodable {
    let tickers: [TickerLeaderboardItem]
    let count: Int?
}

struct TickerLeaderboardItem: Decodable, Identifiable {
    var id: String { ticker }
    let ticker: String
    let name: String?
    let tradeCount: Int
    let buyCount: Int?
    let sellCount: Int?
    let memberCount: Int?
    let estVolumeUsd: Double?
    let estNetFlowUsd: Double?
}

struct VolumeOverTimeResponse: Decodable {
    let series: [VolumeOverTimePoint]
    let granularity: String?
    let count: Int?
}

struct VolumeOverTimePoint: Decodable, Identifiable {
    var id: String { period }
    let period: String
    let buys: Int
    let sells: Int
    let estBuyVolUsd: Double?
    let estSellVolUsd: Double?
}

struct SectorFlowResponse: Decodable {
    let sectors: [SectorFlowItem]
    let count: Int?
}

struct SectorFlowItem: Decodable, Identifiable {
    var id: String { sector }
    let sector: String
    let tradeCount: Int?
    let buyCount: Int?
    let sellCount: Int?
    let estVolumeUsd: Double?
    let estNetFlowUsd: Double?
    let uniqueMembers: Int?
    let uniqueTickers: Int?
}

struct MemberLeaderboardResponse: Decodable {
    let members: [MemberLeaderboardItem]
    let count: Int?
}

struct MemberLeaderboardItem: Decodable, Identifiable {
    var id: String { filerId }
    let filerId: String
    let fullName: String?
    let party: String?
    let chamber: String?
    let state: String?
    let tradeCount: Int?
    let buyCount: Int?
    let sellCount: Int?
    let estVolumeUsd: Double?
    let estNetFlowUsd: Double?
}

struct ClusterBuysResponse: Decodable {
    let clusters: [ClusterBuyItem]
    let count: Int?
}

struct ClusterBuyItem: Decodable, Identifiable {
    var id: String { "\(ticker)-\(txType)-\(firstSeen ?? "")" }
    let ticker: String
    let name: String?
    let txType: String
    let memberCount: Int
    let tradeCount: Int?
    let estVolumeUsd: Double?
    let firstSeen: String?
    let lastSeen: String?
}
