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
    /// Additive/optional (`app/docs/client-mobile-api.md` "Entitlement
    /// semantics (Stripe OR Apple)"): `"stripe" | "apple" | null`. Absent on
    /// server responses that haven't been touched to add it yet — never
    /// treat a missing/nil value as "not premium"; always gate UI on
    /// `premium`, and use this only to choose which "Manage subscription"
    /// surface (App Store vs. Stripe billing portal) to show.
    let source: String?
}

struct ClientFeedResponse: Decodable {
    let items: [ClientTrade]
    let cursor: Int?
    let count: Int?
    let total: Int?
    let limit: Int?
    let nextPollAfterSec: Int?
}

@Model
final class ClientTrade: Decodable, Identifiable {
    @Attribute(.unique) var id: String
    var cursor: Int?
    var docId: String?
    var storedMember: Member?
    var storedAsset: Asset?
    var storedTransaction: Transaction?
    var storedFiling: Filing?
    var confidence: Double?
    var source: Source?

    var member: Member {
        get { storedMember ?? Member() }
        set { storedMember = newValue }
    }

    var asset: Asset {
        get { storedAsset ?? Asset() }
        set { storedAsset = newValue }
    }

    var transaction: Transaction {
        get { storedTransaction ?? Transaction(type: "B") }
        set { storedTransaction = newValue }
    }

    var filing: Filing {
        get { storedFiling ?? Filing() }
        set { storedFiling = newValue }
    }

    /// `CaseIterable` so `ClientTradeCacheSchema` can fingerprint the raw values:
    /// dropping a case leaves cached rows holding a raw value that no longer maps
    /// to anything, and SwiftData traps on the fault rather than returning nil.
    enum Source: String, Codable, CaseIterable {
        case primary
        case seedDataset = "seed_dataset"
        case competitorBackfill = "competitor_backfill"

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            let raw = (try? container.decode(String.self)) ?? ""
            self = Source(rawValue: raw) ?? .primary
        }
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
        var name: String?
        var ticker: String?
        var type: String?
        var sector: String?
        var marketCapBucket: String?

        var displayName: String {
            if let ticker = ticker?.trimmingCharacters(in: .whitespacesAndNewlines), !ticker.isEmpty {
                return ticker
            }
            if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                return name.formattedCompanyName
            }
            if let type = type?.trimmingCharacters(in: .whitespacesAndNewlines), !type.isEmpty {
                return type.capitalized
            }
            return "Asset"
        }
    }

    struct Transaction: Codable {
        var date: String?
        var type: String
        var owner: String?
        var amountMin: Int?
        var amountMax: Int?
        var isOption: Bool?

        init(
            date: String? = nil,
            type: String,
            owner: String? = nil,
            amountMin: Int? = nil,
            amountMax: Int? = nil,
            isOption: Bool? = nil
        ) {
            self.date = date
            self.type = type
            self.owner = owner
            self.amountMin = amountMin
            self.amountMax = amountMax
            self.isOption = isOption
        }

        /// STOCK Act brackets are usually integers, but some cleaned / private-fund
        /// rows arrive as fractional USD (e.g. 982.18). Strict `Int` decoding then
        /// fails the whole member/feed payload with "isn't in the correct format"
        /// (owner report: Max Miller profile, 2026-08-09). Accept Int, Double, or
        /// numeric String and round to the nearest whole dollar for display.
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            date = try container.decodeIfPresent(String.self, forKey: .date)
            type = try container.decodeIfPresent(String.self, forKey: .type) ?? "B"
            owner = try container.decodeIfPresent(String.self, forKey: .owner)
            amountMin = try Self.decodeFlexibleInt(from: container, forKey: .amountMin)
            amountMax = try Self.decodeFlexibleInt(from: container, forKey: .amountMax)
            isOption = try container.decodeIfPresent(Bool.self, forKey: .isOption)
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encodeIfPresent(date, forKey: .date)
            try container.encode(type, forKey: .type)
            try container.encodeIfPresent(owner, forKey: .owner)
            try container.encodeIfPresent(amountMin, forKey: .amountMin)
            try container.encodeIfPresent(amountMax, forKey: .amountMax)
            try container.encodeIfPresent(isOption, forKey: .isOption)
        }

        private enum CodingKeys: String, CodingKey {
            case date, type, owner, amountMin, amountMax, isOption
        }

        private static func decodeFlexibleInt(
            from container: KeyedDecodingContainer<CodingKeys>,
            forKey key: CodingKeys
        ) throws -> Int? {
            guard container.contains(key), try !container.decodeNil(forKey: key) else { return nil }
            if let int = try? container.decode(Int.self, forKey: key) { return int }
            if let double = try? container.decode(Double.self, forKey: key) {
                return Int(double.rounded())
            }
            if let string = try? container.decode(String.self, forKey: key) {
                let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
                if let int = Int(trimmed) { return int }
                if let double = Double(trimmed) { return Int(double.rounded()) }
            }
            return nil
        }
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
        self.storedMember = member
        self.storedAsset = asset
        self.storedTransaction = transaction
        self.storedFiling = filing
        self.confidence = confidence
        self.source = source
    }

    required init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.cursor = try container.decodeIfPresent(Int.self, forKey: .cursor)
        self.docId = try container.decodeIfPresent(String.self, forKey: .docId) ?? ""
        self.storedMember = try container.decodeIfPresent(Member.self, forKey: .storedMember) ?? Member()
        self.storedAsset = try container.decodeIfPresent(Asset.self, forKey: .storedAsset) ?? Asset()
        self.storedTransaction = try container.decodeIfPresent(Transaction.self, forKey: .storedTransaction) ?? Transaction(type: "B")
        self.storedFiling = try container.decodeIfPresent(Filing.self, forKey: .storedFiling) ?? Filing()
        self.confidence = try container.decodeIfPresent(Double.self, forKey: .confidence) ?? 1.0
        self.source = try container.decodeIfPresent(Source.self, forKey: .source) ?? .primary
    }

    enum CodingKeys: String, CodingKey {
        case id, cursor, docId
        case storedMember = "member"
        case storedAsset = "asset"
        case storedTransaction = "transaction"
        case storedFiling = "filing"
        case confidence, source
    }

    /// Copies a freshly decoded snapshot over this cached row (upsert path in
    /// `replaceCache`), so unchanged trades aren't deleted and re-inserted on
    /// every poll.
    func apply(_ item: ClientTrade) {
        cursor = item.cursor
        docId = item.docId
        storedMember = item.storedMember
        storedAsset = item.storedAsset
        storedTransaction = item.storedTransaction
        storedFiling = item.storedFiling
        confidence = item.confidence
        source = item.source
    }
}

/// Identity of the **persisted** shape of the `ClientTrade` cache, compared at
/// launch by `CongressTradeApp.makeTradeCacheContainer()` so a store written by
/// a differently-shaped build is discarded instead of trapping.
///
/// WHY THIS EXISTS — the crash it fixes
/// -----------------------------------
/// `ClientTrade` is a `@Model` whose stored properties are Codable *structs*
/// (`Member`/`Asset`/`Transaction`/`Filing`). SwiftData persists each of those
/// as an `NSCompositeAttributeDescription` — one sub-attribute per struct field,
/// not an opaque blob. When a field's presence or optionality changes between
/// builds, an existing store still holds the old sub-attributes, and SwiftData
/// **traps** (`_assertionFailure`, `EXC_BREAKPOINT`) the moment that property is
/// faulted. Four such crash reports exist from 2026-08-10; every one dies in
/// `ClientTrade.storedAsset.getter` while `TradeCard.body` builds its `HStack`.
///
/// Two facts make this the only workable defence:
///  1. Opening the container does **not** catch it. In a standalone repro the
///     container opened, the fetch returned rows, and only the property fault
///     trapped — so a `do`/`catch` around `ModelContainer(...)` is necessary but
///     nowhere near sufficient.
///  2. The trap is a Swift runtime trap, not a thrown error and not an ObjC
///     exception. Nothing in the language can intercept it: no `try?`, no
///     `catch`, no top-level handler. The only way to survive a mismatched
///     store is to never fault a row out of one.
///
/// So the shape is stamped next to the store and compared *before* the store is
/// opened. If it differs, the store is deleted. That is always safe here: this
/// store is a pure cache of `GET /api/client/v1/feed` (see
/// `CongressTradeStore.replaceCache`) and the only reader is
/// `FeedDashboardView`'s `@Query`. Watchlist, delivery and account state live
/// server-side, so a wipe costs one refetch and loses nothing.
///
/// The stamp is derived automatically wherever that is possible, because the
/// proximate cause of the crash was a shape change landing without anyone
/// realising a hand-maintained version needed bumping.
enum ClientTradeCacheSchema {
    /// Bump when the persisted shape changes in a way the automatic signature
    /// below cannot see — e.g. adding/removing a `@Model` stored property whose
    /// Swift type name is unchanged, changing an `@Attribute` option, or a
    /// SwiftData/OS-level storage format change we need to force past.
    ///
    /// Forgetting to bump a version like this is exactly what shipped the crash,
    /// which is why almost everything here is derived rather than hand-written:
    /// treat this constant as the escape hatch, not the primary mechanism.
    static let persistedShapeVersion = 1

    /// Stable across launches and across processes — deliberately **not**
    /// `Hashable.hashValue`, which is seeded per-process and would report a
    /// mismatch on every single launch.
    static var identity: String {
        "v\(persistedShapeVersion)-\(fnv1a(signature))"
    }

    /// Everything that determines whether an existing store can be faulted by
    /// this build:
    ///
    /// * SwiftData's own view of the entity (property names + value types).
    ///   This catches renames like `asset` -> `storedAsset` and any added or
    ///   dropped `@Model` property.
    /// * The interior of each Codable struct. `Schema` reports these only as
    ///   `Optional<Asset>` and stops there, yet the interior is precisely what
    ///   traps — `Asset.name` going `String` -> `String?` (commit 8f917f85) is
    ///   invisible to `Schema` and fatal to an old store.
    /// * `Source`'s raw values. A dropped case leaves rows whose stored raw
    ///   value no longer maps to anything, which traps the same way.
    private static var signature: String {
        var parts: [String] = []

        for entity in Schema([ClientTrade.self]).entities.sorted(by: { $0.name < $1.name }) {
            let properties = entity.properties
                .map { "\($0.name):\($0.valueType):\($0.isOptional ? "opt" : "req")" }
                .sorted()
                .joined(separator: ",")
            parts.append("\(entity.name)[\(properties)]")
        }

        parts.append(structSignature("Member", ClientTrade.Member()))
        parts.append(structSignature("Asset", ClientTrade.Asset()))
        parts.append(structSignature("Transaction", ClientTrade.Transaction(type: "B")))
        parts.append(structSignature("Filing", ClientTrade.Filing()))
        parts.append("Source[\(ClientTrade.Source.allCases.map(\.rawValue).sorted().joined(separator: ","))]")

        return parts.joined(separator: "|")
    }

    /// `Mirror` reports a stored property's declared type even when its value is
    /// `nil`, so a default-constructed value is enough to fingerprint the shape:
    /// `name:Optional<String>` and `name:String` are different signatures, which
    /// is the distinction that matters to the store.
    private static func structSignature(_ name: String, _ value: Any) -> String {
        let fields = Mirror(reflecting: value)
            .children
            .map { "\($0.label ?? "?"):\(type(of: $0.value))" }
            .sorted()
            .joined(separator: ",")
        return "\(name)[\(fields)]"
    }

    /// FNV-1a — small, dependency-free, and identical on every launch.
    private static func fnv1a(_ input: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in input.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(hash, radix: 16)
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
    
    /// Trade-date buy skill (flat fields) plus optional dual anchors for newer backends.
    struct MemberPerformance: Decodable {
        let tradeCount: Int
        let scoredCount: Int
        let winRate: Double?
        let medianReturn: Double?
        let medianExcess: Double?
        let avgReturn: Double?
        let avgExcess: Double?
        let avgAnnualizedExcess: Double?
        let side: String?
        let buyCount: Int?
        let tradeDate: PerformanceLeg?
        let filingDate: PerformanceLeg?
    }

    /// One anchor leg: trade-date (approx skill) or filing-date (copy-trade).
    struct PerformanceLeg: Decodable {
        let tradeCount: Int
        let scoredCount: Int
        let winRate: Double?
        let medianReturn: Double?
        let medianExcess: Double?
        let avgReturn: Double?
        let avgExcess: Double?
        let avgAnnualizedExcess: Double?
    }
}

/// `GET /api/members` — the People directory roster (owner punch list #2,
/// item 9). Public, origin-level endpoint (not under `/api/client/v1/*`),
/// same pattern as `/api/transactions`: `APIClient.membersDirectory()` calls
/// it against `originURL`, not `baseURL`. See `app/docs/client-mobile-api.md`.
struct MemberDirectoryResponse: Decodable {
    let members: [MemberDirectoryEntry]
    let count: Int
}

struct MemberDirectoryEntry: Decodable, Identifiable, Hashable {
    let filerId: String
    let fullName: String?
    let chamber: String?
    let party: String?
    let state: String?
    let district: String?
    let txCount: Int?
    /// Same-columns addition to the roster query (2026-08-09); `nil` when the
    /// filer has no `filers.photo_url` — falls back to the party-emoji tile.
    let photoUrl: String?

    var id: String { filerId }
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

    /// JSON object for `create_subscription` payloads, omitting unset fields
    /// (undefined = "all" on the backend, so keys must not be sent empty).
    var commandPayload: [String: Any] {
        var payload: [String: Any] = [:]
        if let members, !members.isEmpty { payload["members"] = members }
        if let tickers, !tickers.isEmpty { payload["tickers"] = tickers }
        if let chambers, !chambers.isEmpty { payload["chambers"] = chambers }
        if let minAmount { payload["minAmount"] = minAmount }
        if let maxAmount { payload["maxAmount"] = maxAmount }
        if let sides, !sides.isEmpty { payload["sides"] = sides }
        if let sectors, !sectors.isEmpty { payload["sectors"] = sectors }
        if let marketCapBuckets, !marketCapBuckets.isEmpty { payload["marketCapBuckets"] = marketCapBuckets }
        return payload
    }
}

/// Mirrors `GET /api/client/v1/ticker/:ticker` (`app/src/client/routes.ts`):
/// security-ref asset profile + aggregate summary + the trade page.
struct ClientTickerResponse: Decodable {
    let ticker: String
    let asset: TickerAsset
    let summary: TickerSummary
    let items: [ClientTrade]
    let cursor: Int
    let count: Int
    let total: Int

    struct TickerAsset: Decodable {
        let ticker: String
        let companyName: String?
        let logoUrl: String?
        let sector: String?
        let industry: String?
        let assetClass: String?
        let exchangeShort: String?
        let currency: String?
        let marketCap: Double?
        let marketCapBucket: String?
        let currentPrice: Double?
    }

    struct TickerSummary: Decodable {
        let totalTrades: Int?
        let buyCount: Int?
        let sellCount: Int?
        let exchangeCount: Int?
        let estimatedVolumeUsd: Double?
        let estimatedNetFlowUsd: Double?
        let firstTrade: String?
        let lastTrade: String?
        let memberCount: Int?
    }
}

/// Canonical chamber chip selection. One set drives both the visible chips
/// and the `chamber=` request parameter (CT-AUD-010) — there is no separate
/// "what the UI shows" vs "what was requested" state.
enum PartyFilter: String, CaseIterable, Identifiable {
    case democrat = "D"
    case republican = "R"
    case other = "O"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .democrat: return "Democrats"
        case .republican: return "Republicans"
        case .other: return "Other / Ind."
        }
    }

    var emoji: String {
        switch self {
        case .democrat: return "🫏"
        case .republican: return "🐘"
        case .other: return "🦅"
        }
    }

    /// Compact multi-select summary token (e.g. pill text "D+R") — `rawValue`
    /// already is the single-letter form the server/analytics use.
    var summaryLabel: String { rawValue }

    /// Buckets a raw member party string (e.g. "Democratic", "R",
    /// "Independent") the same way the server's `asPartyBucket` does
    /// (`app/src/analytics/sql.ts`): first letter D→Democrat, R→Republican,
    /// anything else non-empty→Other. `nil` for an empty/unresolved value.
    /// Still used as a local belt-and-suspenders pass; the feed now also
    /// accepts `party=` CSV (`asPartyBuckets`).
    static func bucket(for raw: String?) -> PartyFilter? {
        guard let first = raw?.trimmingCharacters(in: .whitespacesAndNewlines).first else { return nil }
        switch first.uppercased() {
        case "D": return .democrat
        case "R": return .republican
        default: return .other
        }
    }
}

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

/// Buy / Sell / Exchange side filter. Multi-select (`CongressTradeStore.
/// selectedTradeTypes: Set<TradeTypeFilter>`, empty = all sides) — the server's
/// `type=` param is single-valued (`asTxType` in `app/src/client/utils.ts`),
/// exactly mirroring the web's own `qSideGroup`/`selectedSideParam` chips,
/// which likewise only forward `type=` when exactly one side is toggled and
/// otherwise fall back to an unfiltered fetch narrowed client-side. See
/// `CongressTradeStore.tradeTypeQueryValue`.
/// Trades-only instrument-class filter (owner: All vs Public Equities, Funds, & ETFs).
enum AssetClassFilter: String, CaseIterable, Identifiable, Hashable {
    case all = "all"
    case equitiesFunds = "equities_funds"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All Assets"
        case .equitiesFunds: return "Public Equities, Funds, & ETFs"
        }
    }

    /// `nil` omits `assetClass=` so the server default (all) applies.
    var queryValue: String? {
        self == .all ? nil : rawValue
    }
}

enum TradeTypeFilter: String, CaseIterable, Identifiable, Hashable {
    case buy = "B"
    case sell = "S"
    case exchange = "E"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .buy: return "Buy"
        case .sell: return "Sell"
        case .exchange: return "Exchange"
        }
    }

    /// Compact multi-select summary token (e.g. pill text "Buys+Sells").
    var summaryLabel: String {
        switch self {
        case .buy: return "Buys"
        case .sell: return "Sells"
        case .exchange: return "Exch"
        }
    }

    /// Whether a cached trade's `transaction.type` matches this filter.
    /// Legacy form letter `P` (Purchase) is a Buy alias, mirroring the
    /// server's ingest/API normalization.
    func matches(txType: String?) -> Bool {
        let t = (txType ?? "").uppercased()
        switch self {
        case .buy: return t == "B" || t == "P"
        case .sell, .exchange: return t == rawValue
        }
    }
}

/// Trades feed sort control (owner punch list #2, item 7) — mirrors the
/// web's `setSort()` (`app/src/ui/dashboardHtml.ts`): `date` is a real
/// backend sort key (`sort=tx_date` on `GET /api/client/v1/feed`, fixed
/// 2026-08-09 — see `app/docs/client-mobile-api.md`), so changing it or its
/// direction refetches the current page. `amount` has no backend sort key;
/// selecting it only re-sorts the trades already loaded on the current page
/// (never a fetch beyond it — same rule the web applies to non-backend
/// columns).
enum FeedSortKey: String, CaseIterable, Identifiable {
    case date
    case amount
    case ticker

    var id: String { rawValue }

    var label: String {
        switch self {
        case .date: return "Date"
        case .amount: return "Amount"
        case .ticker: return "Ticker"
        }
    }

    /// Whether selecting/flipping this key requires a server refetch
    /// (`sort=tx_date`) vs a local-only re-sort of the loaded page.
    var isServerSort: Bool { self == .date }
}

/// Sort direction shared by the Trades sort control's Date/Amount keys.
enum SortDirection: String, CaseIterable, Identifiable {
    case descending = "desc"
    case ascending = "asc"

    var id: String { rawValue }

    var systemImage: String {
        self == .ascending ? "arrow.up" : "arrow.down"
    }

    var accessibilityLabel: String {
        self == .ascending ? "Ascending" : "Descending"
    }

    var toggled: SortDirection {
        self == .ascending ? .descending : .ascending
    }
}

/// `GET /api/analytics/performance/:txId` — asset return, S&P return, excess.
struct TradePerformanceResponse: Decodable {
    let available: Bool
    let isOption: Bool?
    let txType: String?
    let ticker: String?
    let txDate: String?
    let filedDate: String?
    let priceAtTrade: Double?
    let currentPrice: Double?
    let currentPriceDate: String?
    let assetReturn: Double?
    let spxReturn: Double?
    let excessReturn: Double?
    let tradeDatePerformance: PerformanceSlice?
    let filingDatePerformance: PerformanceSlice?

    struct PerformanceSlice: Decodable {
        let priceAt: Double?
        let spxAt: Double?
        let assetReturn: Double?
        let spxReturn: Double?
        let excessReturn: Double?
    }

    /// Prefer nested trade-date slice; fall back to flat top-level fields.
    var tradeLeg: PerformanceSlice? {
        if let tradeDatePerformance { return tradeDatePerformance }
        guard available else { return nil }
        return PerformanceSlice(
            priceAt: priceAtTrade,
            spxAt: nil,
            assetReturn: assetReturn,
            spxReturn: spxReturn,
            excessReturn: excessReturn
        )
    }
}

struct ClientCommandResponse<ResultPayload: Decodable>: Decodable {
    let command: ClientCommand
    let result: ResultPayload?
    let replayed: Bool?
    let error: String?

    private enum CodingKeys: String, CodingKey {
        case command, result, replayed, error
    }

    private enum CommandResultKeys: String, CodingKey {
        case result
    }

    init(command: ClientCommand, result: ResultPayload?, replayed: Bool?, error: String?) {
        self.command = command
        self.result = result
        self.replayed = replayed
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        command = try container.decode(ClientCommand.self, forKey: .command)
        replayed = try container.decodeIfPresent(Bool.self, forKey: .replayed)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        // POST may eventually surface a top-level `result`. GET /commands/:id
        // claims the one-time secret onto `command.result` — accept either.
        if let topLevel = try container.decodeIfPresent(ResultPayload.self, forKey: .result) {
            result = topLevel
        } else if container.contains(.command) {
            let nested = try container.nestedContainer(keyedBy: CommandResultKeys.self, forKey: .command)
            result = try nested.decodeIfPresent(ResultPayload.self, forKey: .result)
        } else {
            result = nil
        }
    }
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

struct DeleteSubscriptionResult: Decodable {
    let deleted: Bool?
    let id: String?
}

struct PreferencesCommandResult: Decodable {
    let preferences: ClientPreferences
}

struct DeviceRegistrationResult: Decodable {
    let device: RegisteredDevice?
}

struct RegisteredDevice: Decodable, Identifiable {
    let id: String
    let platform: String?
    let tokenSuffix: String?
    let appBundle: String?
    let env: String?
    let active: Bool?
    let createdAt: String?
    let updatedAt: String?
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

/// `POST /auth/apple` (`app/docs/client-mobile-api.md` "Sign in with Apple") —
/// same response shape as the Google/magic-link session flows: an opaque
/// bearer `token` (stored the same way, via `CongressTradeStore.
/// saveSessionToken` → Keychain) plus the resolved user + entitlement so
/// callers don't need a second round trip before showing account state.
struct AppleSignInResponse: Decodable {
    let ok: Bool?
    let token: String
    let user: User
    let entitlement: Entitlement?
}

/// Result payload of the `redeem_apple_purchase` client command
/// (`app/docs/client-mobile-api.md` "Apple In-App Purchase (StoreKit 2)").
/// Idempotent on Apple's `originalTransactionId` server-side — restore and
/// first-purchase both resolve here.
struct RedeemAppleResult: Decodable {
    let entitlement: Entitlement?
    let plan: String?
    let expiresAt: String?
    let originalTransactionId: String?
}

/// `POST /billing/portal` response (`app/src/billing/routes.ts`) — a
/// short-lived Stripe-hosted Billing Portal URL for the signed-in user's
/// Stripe customer. Used for `entitlement.source == "stripe"` (or `nil`)
/// subscribers; Apple IAP subscribers go straight to the App Store instead.
struct BillingPortalResponse: Decodable {
    let url: String
}

/// App Store product identifiers (configure matching subscriptions in App Store Connect).
enum AppleIAPProduct: String, CaseIterable, Identifiable {
    case monthly = "trade.congress.premium.monthly"
    case annual = "trade.congress.premium.annual"
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .monthly: return "Premium Monthly"
        case .annual: return "Premium Annual"
        }
    }
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

struct LatencyProvider: Decodable, Identifiable {
    let id: String
    let label: String
    let candidates: Int
    /// Concurrent races only (both first-seen in window, |delta| ≤ 48h).
    let matched: Int
    /// High-confidence overlaps in the window (coverage density); optional for older servers.
    let strongMatched: Int?
    /// CT coverage of matured provider-observed rows; null when the cohort is empty.
    let coveragePct: Double?
    let ctCoveragePct: Double?
    let providerCoveragePct: Double?
    let comparisonStatus: String?
    let usFirstCount: Int
    let providerFirstCount: Int
    let tieCount: Int
    let medianLeadSec: Int?
    let avgLeadSec: Int?
    let p90LeadSec: Int?
    let unmatchedProvider: Int?
    let providerObserved: Int?
}

struct LatencySummary: Decodable {
    let generatedAt: String
    /// Scoreboard window (hours); optional for older servers.
    let windowHours: Int?
    let windowDays: Int?
    /// Max |delta| hours for concurrent-race timing; optional for older servers.
    let maxConcurrentDeltaHours: Int?
    let totals: LatencyTotals
    let scope: LatencyScope?
    let providers: [LatencyProvider]

    struct LatencyScope: Decodable {
        let matched: Int?
        let total: Int?
    }

    struct LatencyTotals: Decodable {
        let racedDisclosures: Int
        let matched: Int
        let pending: Int
        let comparableProviders: Int
        let providerObserved: Int?
        let unmatchedProvider: Int?
        let scopeMatched: Int?
        let scopeTotal: Int?
    }

    var matchedOfTotal: (matched: Int, total: Int)? {
        if let matched = totals.scopeMatched, let total = totals.scopeTotal, total > 0 {
            return (matched, total)
        }
        if let matched = scope?.matched, let total = scope?.total, total > 0 {
            return (matched, total)
        }
        return nil
    }
}

/// Consumer time windows matching the website's Trends/Trades selector
/// (`app/src/ui/dashboardHtml.ts` TR_WINDOW_LABELS / default `90d`) plus
/// calendar-year options requested for iOS parity.
enum TimeRange: String, CaseIterable, Identifiable, Codable {
    case oneDay = "1d"
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case ninetyDays = "90d"
    case sixMonths = "180d"
    case oneYear = "365d"
    case fiveYears = "1825d"
    case thisCalendarYear = "ytd"
    case lastCalendarYear = "prev_year"
    case all = "all"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .oneDay: return "Past Day"
        case .sevenDays: return "Past Week"
        case .thirtyDays: return "Past Month"
        case .ninetyDays: return "Past 3 Months"
        case .sixMonths: return "Past 6 Months"
        case .oneYear: return "Past Year"
        case .fiveYears: return "Past 5 Years"
        case .thisCalendarYear: return "This Calendar Year"
        case .lastCalendarYear: return "Last Calendar Year"
        case .all: return "All Time"
        }
    }

    /// Window string for analytics endpoints. Calendar-year cases map to a
    /// day-count window large enough to cover the range; the feed still uses
    /// exact `from`/`to` ISO bounds below.
    var analyticsWindow: String {
        switch self {
        case .thisCalendarYear, .lastCalendarYear:
            return "365d"
        case .all:
            return "all"
        default:
            return rawValue
        }
    }

    /// ISO `yyyy-MM-dd` lower bound for `?from=` on the feed, or `nil` for all-time.
    var fromDateISO: String? {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let formatter = Self.isoDayFormatter
        switch self {
        case .all:
            return nil
        case .thisCalendarYear:
            let year = cal.component(.year, from: Date())
            var comps = DateComponents()
            comps.year = year
            comps.month = 1
            comps.day = 1
            guard let date = cal.date(from: comps) else { return nil }
            return formatter.string(from: date)
        case .lastCalendarYear:
            let year = cal.component(.year, from: Date()) - 1
            var comps = DateComponents()
            comps.year = year
            comps.month = 1
            comps.day = 1
            guard let date = cal.date(from: comps) else { return nil }
            return formatter.string(from: date)
        case .oneDay, .sevenDays, .thirtyDays, .ninetyDays, .sixMonths, .oneYear, .fiveYears:
            let days: Int
            switch self {
            case .oneDay: days = 1
            case .sevenDays: days = 7
            case .thirtyDays: days = 30
            case .ninetyDays: days = 90
            case .sixMonths: days = 180
            case .oneYear: days = 365
            case .fiveYears: days = 1825
            default: return nil
            }
            guard let date = cal.date(byAdding: .day, value: -days, to: Date()) else { return nil }
            return formatter.string(from: date)
        }
    }

    /// ISO `yyyy-MM-dd` upper bound for `?to=` when the window has a hard end
    /// (last calendar year ends Dec 31 of that year). `nil` means open-ended.
    var toDateISO: String? {
        guard self == .lastCalendarYear else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let year = cal.component(.year, from: Date()) - 1
        var comps = DateComponents()
        comps.year = year
        comps.month = 12
        comps.day = 31
        guard let date = cal.date(from: comps) else { return nil }
        return Self.isoDayFormatter.string(from: date)
    }

    private static let isoDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
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

    var formattedName: String? {
        name?.formattedCompanyName
    }
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

    var formattedName: String? {
        name?.formattedCompanyName
    }
}

struct TrendingResponse: Decodable {
    let trending: [TrendingItem]
    let count: Int?
}

struct TrendingItem: Decodable, Identifiable {
    var id: String { ticker }
    let ticker: String
    let name: String?
    let recentCount: Int
    let priorCount: Int
    let deltaCount: Int?
    let changePct: Double?
    let recentMembers: Int?
    let estRecentVolumeUsd: Double?
    let estRecentNetFlowUsd: Double?

    var formattedName: String? {
        name?.formattedCompanyName
    }
}

struct TopPerformersResponse: Decodable {
    let members: [TopPerformerItem]
    let count: Int?
    let note: String?
}

struct TopPerformerItem: Decodable, Identifiable {
    var id: String { filerId }
    let filerId: String
    let fullName: String?
    let party: String?
    let partyBucket: String?
    let photoUrl: String?
    let tradeCount: Int
    /// CANONICAL. Size-weighted average excess return vs the S&P 500 measured
    /// from the FILING date, winsorized per-trade at ±200%, NOT annualized.
    /// `GET /api/analytics/member-performance` both SORTS and (on the website)
    /// DISPLAYS this field, so it is the only one that keeps a row's rank and
    /// its printed number in agreement. Display this one.
    let avgExcessReturn: Double?
    /// Reference/debugging only — do NOT display as the headline stat. The
    /// backend's own comment (`app/src/analytics/routes.ts`) says it is "NOT
    /// what the board sorts or displays by (a young trade's ~12x annualization
    /// multiplier made this misleading)". Painting it next to a list ordered
    /// by `avgExcessReturn` is what produced the owner's "odd order" report:
    /// live at window=90d the honest column tops out near 5.7% while this one
    /// reads 41.4 / 26.4 / 22.5 / 41.2%.
    let avgAnnualizedExcessReturn: Double?
    let winRate: Double?
    let estVolumeUsd: Double?
}

struct MarketCapResponse: Decodable {
    let buckets: [MarketCapItem]
    let count: Int?
}

struct MarketCapItem: Decodable, Identifiable {
    var id: String { bucket }
    let bucket: String
    let tradeCount: Int
    let buyCount: Int?
    let sellCount: Int?
    let estVolumeUsd: Double?
    let estNetFlowUsd: Double?
    let uniqueMembers: Int?
    let uniqueTickers: Int?
}

struct PartySplitResponse: Decodable {
    let overall: [String: PartySplitSummary]?
}

struct PartySplitSummary: Decodable {
    let buys: Int
    let sells: Int
    let estVolumeUsd: Double?
    let estNetFlowUsd: Double?
    let members: Int?
}

struct FilingLagResponse: Decodable {
    let summary: FilingLagSummary?
    let topLateFilers: [SlowFilerItem]?
}

/// Shape of `summary` in `GET /api/analytics/filing-lag`.
///
/// VERIFIED AGAINST THE LIVE ENDPOINT (2026-08-11, `?window=90d`): the server
/// returns exactly `{count, medianLagDays, p90LagDays, overFortyFivePct,
/// distribution}` — see `summarizeLag` in `app/src/analytics/compute.ts`, which
/// is the only producer of this object.
///
/// This struct previously also declared `avgLagDays` / `maxLagDays` /
/// `lateCount` / `totalTrades`. None of them have ever been sent. Because every
/// property is Optional, decoding still succeeded and the Trends tab happily
/// shipped "Avg Delay: 0 days" and "Late Filings: —" forever. Do not re-add a
/// field here without first seeing it in a live response body; the website
/// (Median / P90 / >45-day %) is the reference for what this endpoint offers.
struct FilingLagSummary: Decodable {
    /// Disclosed trades with a computable lag in the active window — the
    /// denominator behind every other number in this object.
    let count: Int?
    let medianLagDays: Double?
    let p90LagDays: Double?
    /// Share (0…1, NOT a percent) of `count` filed more than 45 days after the
    /// trade — i.e. past the STOCK Act deadline. `round(…, 4)` server-side.
    let overFortyFivePct: Double?
    let distribution: [FilingLagBucket]?
}

/// One `LAG_BUCKETS` histogram bar (`0-7d`, `8-14d`, `15-30d`, `31-45d`,
/// `46-60d`, `60d+`). Shared with the website via the `congress-trading-shared`
/// package, so the labels arrive pre-formatted — never re-derive them here.
struct FilingLagBucket: Decodable, Identifiable {
    var id: String { bucket }
    let bucket: String
    let count: Int
}

struct SlowFilerItem: Decodable, Identifiable {
    var id: String { filerId }
    let filerId: String
    let fullName: String?
    let partyBucket: String?
    let chamber: String?
    let photoUrl: String?
    let avgLagDays: Double?
    let maxLagDays: Double?
    let lateCount: Int?
    let tradeCount: Int?
}

struct ConflictCandidateResponse: Decodable {
    let conflicts: [ConflictCandidateItem]?
    let count: Int?
}

struct ConflictCandidateItem: Decodable, Identifiable {
    var id: String { "\(bioguideId)_\(committeeCode)_\(ticker)_\(date)" }
    let bioguideId: String
    let memberName: String?
    let partyBucket: String?
    let photoUrl: String?
    let committeeCode: String
    let committeeName: String?
    let sector: String
    let ticker: String
    let companyName: String?
    let date: String
    let txType: String
    let amountMin: Double?
    let amountMax: Double?
    let estVolumeUsd: Double?
}

// MARK: - Company Name Normalization Helper

extension String {
    /// Formats raw company/asset names into clean Title Case while stripping
    /// state-of-incorporation suffixes (e.g. "/DE/", "/CA/"), trailing stock exchange/common stock noise,
    /// and preserving acronyms (e.g. "AT&T", "IBM", "LLC", "INC", "S&P").
    var formattedCompanyName: String {
        let trimmed = self.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return trimmed }

        // 1. Remove trailing exchange descriptors: e.g. "(NYSE)", "(NASDAQ: AAPL)"
        var text = trimmed.replacingOccurrences(
            of: #"\s*\([A-Z]+(?:\s*:\s*[A-Z]+)?\)\s*$"#,
            with: "",
            options: .regularExpression
        )

        // 2. Strip state of incorporation suffix (e.g. "/DE/", "/DE", "/MD/", "/PA/", " /DE/")
        let states: Set<String> = [
            "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
            "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
            "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
            "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
            "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
        ]

        for state in states {
            text = text.replacingOccurrences(of: "/\(state)/", with: " ", options: .caseInsensitive)
            if text.lowercased().hasSuffix("/\(state.lowercased())") {
                text = String(text.dropLast(state.count + 1))
            }
        }

        text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        text = text.replacingOccurrences(of: #"/\s*$"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)

        // 3. Remove Common Stock / Class A / etc. trailing noise if raw
        text = text.replacingOccurrences(of: #"(?i)\s*(?:-)?\s*Common Stock\b"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)

        // Check if string is ALL CAPS
        let hasLetters = text.contains(where: { $0.isLetter })
        let isAllCaps = hasLetters && text.uppercased() == text

        if isAllCaps {
            let tokenMap: [String: String] = [
                "inc": "Inc.", "inc.": "Inc.",
                "corp": "Corp.", "corp.": "Corp.",
                "co": "Co.", "co.": "Co.",
                "llc": "LLC", "llc.": "LLC",
                "ltd": "Ltd.", "ltd.": "Ltd.",
                "plc": "PLC", "plc.": "PLC",
                "lp": "LP", "lp.": "LP",
                "nv": "NV", "nv.": "NV",
                "ag": "AG", "ag.": "AG",
                "sa": "SA", "sa.": "SA",
                "bv": "BV", "bv.": "BV",
                "cbs": "CBS", "ibm": "IBM", "att": "AT&T", "amd": "AMD",
                "bp": "BP", "kkr": "KKR", "msci": "MSCI", "nrg": "NRG",
                "pnc": "PNC", "ubs": "UBS", "etf": "ETF", "reit": "REIT",
                "usa": "USA", "sec": "SEC", "nyse": "NYSE", "nasdaq": "NASDAQ"
            ]

            let words = text.components(separatedBy: " ")
            let formattedWords = words.enumerated().map { (idx, word) -> String in
                let lower = word.lowercased()
                let cleanKey = lower.trimmingCharacters(in: .punctuationCharacters)
                if let mapped = tokenMap[cleanKey] {
                    if lower.hasSuffix(".") && !mapped.hasSuffix(".") {
                        return mapped + "."
                    }
                    return mapped
                }
                if ["the", "and", "for", "of", "in", "on", "at", "to"].contains(lower) && idx > 0 {
                    return lower
                }
                return word.capitalized
            }
            text = formattedWords.joined(separator: " ")
        }

        // Clean double punctuation / double spaces
        text = text.replacingOccurrences(of: #"\s+([.,])"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
