import Foundation
import SwiftData

@MainActor
final class CongressTradeStore: ObservableObject {
    @Published private(set) var bootstrap: BootstrapResponse?
    @Published private(set) var feed: ClientFeedResponse?
    /// Authoritative trade count for the active filters (from the feed API's COUNT(*)).
    /// Never use cursor_seq as a "trades" KPI — sequences can exceed live rows.
    @Published private(set) var tradeTotal: Int = 0
    @Published private(set) var latencySummary: LatencySummary?
    @Published private(set) var analyticsSummary: AnalyticsSummary?
    @Published private(set) var tickerLeaderboard: [TickerLeaderboardItem] = []
    @Published private(set) var volumeSeries: [VolumeOverTimePoint] = []
    @Published private(set) var sectorFlow: [SectorFlowItem] = []
    @Published private(set) var memberLeaderboard: [MemberLeaderboardItem] = []
    @Published private(set) var clusterBuys: [ClusterBuyItem] = []
    @Published private(set) var trendingAssets: [TrendingItem] = []
    @Published private(set) var topPerformers: [TopPerformerItem] = []
    @Published private(set) var marketCapBuckets: [MarketCapItem] = []
    @Published private(set) var partySplit: PartySplitResponse?
    @Published private(set) var filingLag: FilingLagResponse?
    @Published private(set) var selectedParty: PartyFilter? = nil
    @Published private(set) var isLoadingTrends = false
    @Published private(set) var trendsNotice: String?
    @Published private(set) var subscriptions: [Subscription] = []
    @Published private(set) var commands: [ClientCommand] = []
    @Published private(set) var watchlist: [String] = []
    @Published private(set) var isRefreshing = false
    @Published private(set) var isSavingWatchlist = false
    @Published private(set) var isCreatingDelivery = false
    @Published private(set) var subscriptionIDsInFlight: Set<String> = []
    @Published private(set) var isLoggingOut = false
    @Published private(set) var feedNotice: String?
    @Published private(set) var watchlistNotice: String?
    @Published private(set) var deliveryNotice: String?
    @Published private(set) var commandNotice: String?
    @Published private(set) var lastCommand: ClientCommand?
    @Published var pendingDeliveryCredential: DeliveryCredential?
    @Published private(set) var lastSuccessfulRefresh: Date?
    @Published private(set) var isOffline = false
    @Published private(set) var hasStoredSessionToken = false
    /// Page size for the visible feed snapshot (newest first). Not a multi-page crawl.
    @Published var viewLimit: Int = 100 {
        didSet {
            if oldValue != viewLimit {
                // A different page size shifts every page boundary — stay on
                // a page that's guaranteed to exist under the new size.
                currentPage = 0
                Task { await refresh() }
            }
        }
    }
    /// 0-indexed page of the current filtered/sorted snapshot (owner punch
    /// list #2, item 8). `refresh()` sends it as `offset = currentPage *
    /// pageLimit`; every filter/sort/page-size change below resets it to 0
    /// so the user is never stranded on a now-out-of-range page.
    @Published private(set) var currentPage: Int = 0
    /// Trades sort control (owner punch list #2, item 7).
    @Published private(set) var feedSortKey: FeedSortKey = .date
    @Published private(set) var feedSortDirection: SortDirection = .descending
    /// People directory roster (owner punch list #2, item 9).
    @Published private(set) var members: [MemberDirectoryEntry] = []
    @Published private(set) var isLoadingMembers = false
    @Published private(set) var membersNotice: String?
    /// Canonical chamber chip selection. Drives both the visible chips and
    /// the `chamber=` feed request — see `chamberQueryValue`. CT-AUD-010.
    /// Empty set = no chamber filter (all branches). Mirrors the website HSP chips
    /// where nothing selected means all. Non-empty = filter to that subset.
    /// Empty = all branches (website HSP: no chips selected). Non-empty filters to that subset.
    @Published private(set) var selectedChambers: Set<ChamberFilter> = []
    /// Time window for the feed + trends (website default = Past 3 Months).
    @Published private(set) var selectedTimeRange: TimeRange = .ninetyDays
    /// Buy / Sell / All side filter (`type=` on feed + local cache filter).
    @Published private(set) var selectedTradeType: TradeTypeFilter = .all
    /// $-threshold pill (`minAmount=` on feed + local cache filter). Website
    /// parity with the shared `qMinAmt`/`trMinAmt` row, mirrored on Trends.
    @Published private(set) var selectedAmountThreshold: AmountThresholdFilter = .any
    /// Trades-only free-text politician filter (`memberName=`).
    @Published private(set) var politicianFilter: String = ""
    /// Trades-only asset/ticker filter (`ticker=`).
    @Published private(set) var assetFilter: String = ""

    @Published var isLoadingMore = false

    var modelContext: ModelContext?

    internal let api: CongressTradeAPIClient
    private let tokenStore = KeychainTokenStore()
    private let cursorStore: SyncCursorStore
    private let sleeper: (Double) async -> Void
    private var pendingWatchlistMutation: PendingWatchlistMutation?
    private var pendingDeliveryMutation: PendingDeliveryMutation?
    private var pendingSubscriptionMutations: [String: PendingSubscriptionMutation] = [:]
    /// Set when a `refresh()` is requested while one is already running (e.g. the
    /// user toggles chambers mid catch-up). The in-flight refresh re-runs once
    /// against the latest selection when it finishes.
    private var refreshQueued = false
    /// Foreground poll timer driven by the feed's `nextPollAfterSec`
    /// (`ClientFeedResponse`). Cancelled while the app is backgrounded.
    private var autoRefreshTask: Task<Void, Never>?
    private var autoRefreshPaused = false
    /// Server-side search term applied on submit (`ticker=` when it looks like
    /// a symbol, otherwise `member=`). Local debounced filtering of the loaded
    /// cache is unchanged and happens in the view layer.
    private var searchTerm: String?

    /// Soft cap on local cache rows (newest by trade date). Avoids multi-thousand
    /// seed crawls while still supporting offline read-back of the last window.
    private var cacheLimit: Int { max(400, viewLimit * 3) }
    private var pageLimit: Int { min(max(viewLimit, 50), 200) }
    /// Attempts (including the first) for a single page fetch before giving up.
    private static let maxAttemptsPerPage = 3
    /// Mirrors the server's `MAX_PUBLIC_TX_OFFSET` (app/src/security/botDefense.ts)
    /// so the pager disables "Next" before ever sending a request the public
    /// feed would 400 — deep paging past this depth is Premium CSV export's job.
    private static let maxPublicOffset = 2000
    private var membersLastLoadedAt: Date?
    private static let membersCacheTTL: TimeInterval = 5 * 60
    /// The backend's true default view when `chamber` is omitted entirely:
    /// Congressional chambers, excluding Executive (OGE 278-T) disclosures
    /// unless explicitly requested. See app/docs/client-mobile-api.md.
    static let defaultChambers: Set<ChamberFilter> = [.house, .senate]
    static let initialChambers: Set<ChamberFilter> = [.house, .senate, .executive]

    init(
        api: CongressTradeAPIClient,
        cursorStore: SyncCursorStore = UserDefaultsSyncCursorStore(),
        sleeper: @escaping (Double) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64((seconds * 1_000_000_000).rounded()))
        }
    ) {
        self.api = api
        self.cursorStore = cursorStore
        self.sleeper = sleeper
        let storedToken = try? api.tokenStore.load()
        self.hasStoredSessionToken = storedToken?.isEmpty == false
    }

    var signedIn: Bool {
        bootstrap?.auth.user != nil
    }

    var signedInUser: User? {
        bootstrap?.auth.user
    }

    var isPremium: Bool {
        bootstrap?.auth.entitlement.premium == true
    }

    var entitlementLabel: String {
        isPremium ? "Premium" : "Free"
    }

    static func parseTickers(_ text: String) -> [String] {
        text
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
            .filter { !$0.isEmpty }
    }

    /// Selects the chamber chips and immediately resyncs against that
    /// selection's own request. Never allows an empty selection.
    func setChamberSelection(_ chambers: Set<ChamberFilter>) async {
        // Allow empty = all branches (website parity with unselected H/S/P).
        selectedChambers = chambers
        currentPage = 0
        async let r1: Void = refresh()
        async let r2: Void = refreshTrends()
        _ = await (r1, r2)
    }

    func setTimeRange(_ range: TimeRange) async {
        guard range != selectedTimeRange else { return }
        selectedTimeRange = range
        currentPage = 0
        async let r1: Void = refresh()
        async let r2: Void = refreshTrends()
        _ = await (r1, r2)
    }

    func setTradeType(_ type: TradeTypeFilter) async {
        guard type != selectedTradeType else { return }
        selectedTradeType = type
        currentPage = 0
        async let r1: Void = refresh()
        async let r2: Void = refreshTrends()
        _ = await (r1, r2)
    }

    /// $-threshold pill (server `minAmount=`). Mirrors `setTradeType`: also
    /// pings `refreshTrends()` for shared-filter-row consistency even though
    /// the analytics endpoints don't yet accept `minAmount` (same precedent
    /// as the side/type filter above).
    func setAmountThreshold(_ threshold: AmountThresholdFilter) async {
        guard threshold != selectedAmountThreshold else { return }
        selectedAmountThreshold = threshold
        currentPage = 0
        async let r1: Void = refresh()
        async let r2: Void = refreshTrends()
        _ = await (r1, r2)
    }

    /// Trades-only politician name filter (server `memberName=`).
    func setPoliticianFilter(_ text: String) async {
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard next != politicianFilter else { return }
        politicianFilter = next
        currentPage = 0
        await refresh()
    }

    /// Trades-only asset/ticker filter (server `ticker=`).
    func setAssetFilter(_ text: String) async {
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard next != assetFilter else { return }
        assetFilter = next
        currentPage = 0
        await refresh()
    }

    // MARK: - Trades sort control (owner punch list #2, item 7)

    /// Selecting Date refetches the current page with `sort=tx_date` in the
    /// existing direction; selecting Amount is a local re-sort only (no
    /// backend `amount` sort key — see `FeedSortKey.isServerSort`).
    func setFeedSortKey(_ key: FeedSortKey) async {
        guard key != feedSortKey else { return }
        feedSortKey = key
        guard key.isServerSort else { return }
        currentPage = 0
        await refresh()
    }

    /// Flips asc/desc for whichever sort key is active. Only a server-sort
    /// key (currently Date) needs a refetch; Amount just re-renders the
    /// already-loaded page in the new direction.
    func toggleFeedSortDirection() async {
        feedSortDirection = feedSortDirection.toggled
        guard feedSortKey.isServerSort else { return }
        currentPage = 0
        await refresh()
    }

    // MARK: - Pagination (owner punch list #2, item 8)

    /// Rows actually requested per page — already existed internally as
    /// `pageLimit`; exposed read-only for the "N / page" pager control.
    var pageSize: Int { pageLimit }

    /// `tradeTotal` is the API's `COUNT(*)` for the active filters (never
    /// cursor_seq — see the `tradeTotal` doc comment above), so this is
    /// stable across pages of the same filter set.
    var totalPages: Int {
        guard tradeTotal > 0 else { return 1 }
        return max(1, Int((Double(tradeTotal) / Double(pageLimit)).rounded(.up)))
    }

    var canGoToPreviousPage: Bool { currentPage > 0 }

    /// Also false once the *next* page's offset would exceed the server's
    /// public depth cap, so "Next" never dead-ends on a 400.
    var canGoToNextPage: Bool {
        currentPage + 1 < totalPages && (currentPage + 1) * pageLimit <= Self.maxPublicOffset
    }

    func goToNextPage() async {
        guard canGoToNextPage else { return }
        currentPage += 1
        await refresh()
    }

    func goToPreviousPage() async {
        guard canGoToPreviousPage else { return }
        currentPage -= 1
        await refresh()
    }

    /// Rows-per-page control. Routes through `viewLimit`'s existing `didSet`
    /// (which already resets `currentPage` and refetches) so there is one
    /// path for "page size changed," not two.
    func setPageSize(_ size: Int) {
        viewLimit = size
    }

    /// Applies a server-side search filter (submit path; typing alone keeps
    /// using the local debounced cache filter). `nil`/empty clears it.
    /// Prefer `setPoliticianFilter` / `setAssetFilter` for dedicated fields.
    func setSearch(_ term: String?) async {
        let trimmed = (term ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let next = trimmed.isEmpty ? nil : trimmed
        guard next != searchTerm else { return }
        searchTerm = next
        currentPage = 0
        await refresh()
    }

    /// Short all-caps tokens are treated as ticker symbols (`ticker=`);
    /// anything longer or with spaces goes to free-text politician search
    /// (`memberName=`).
    private static func looksLikeTicker(_ term: String) -> Bool {
        term.range(of: #"^[A-Za-z]{1,5}(\.[A-Za-z]{1,2})?$"#, options: .regularExpression) != nil
    }

    /// Pauses/resumes the foreground poll timer (backgrounded scenes must not
    /// keep polling). Resuming schedules from the last feed's
    /// `nextPollAfterSec`; the next successful refresh re-arms it anyway.
    func setAutoRefreshPaused(_ paused: Bool) {
        autoRefreshPaused = paused
        if paused {
            autoRefreshTask?.cancel()
            autoRefreshTask = nil
        } else {
            scheduleAutoRefresh()
        }
    }

    private func scheduleAutoRefresh() {
        autoRefreshTask?.cancel()
        autoRefreshTask = nil
        guard !autoRefreshPaused, let delay = feed?.nextPollAfterSec else { return }
        // Clamp so a bad server value can neither spin nor stall the loop.
        let seconds = min(max(delay, 15), 300)
        autoRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.refresh()
        }
    }

    func refresh() async {
        guard !isRefreshing else {
            refreshQueued = true
            return
        }
        isRefreshing = true
        feedNotice = nil
        let chambers = selectedChambers
        let chamberParam = Self.chamberQueryValue(for: chambers)
        let from = selectedTimeRange.fromDateISO
        let to = selectedTimeRange.toDateISO
        let search = searchTerm
        let typeParam = selectedTradeType.queryValue
        let minAmountParam = selectedAmountThreshold.queryValue
        // Dedicated fields win; legacy combined search still fills the other slot.
        let tickerParam: String? = {
            if !assetFilter.isEmpty { return assetFilter }
            return search.flatMap { Self.looksLikeTicker($0) ? $0.uppercased() : nil }
        }()
        let memberNameParam: String? = {
            if !politicianFilter.isEmpty { return politicianFilter }
            return search.flatMap { Self.looksLikeTicker($0) ? nil : $0 }
        }()
        // Date is a real backend sort key (`sort=tx_date`); its direction
        // drives `order=`. Amount has no backend sort key, so the fetched
        // page always stays in the stable newest-first server order and the
        // view re-sorts what's already loaded (FeedDashboardView.sortedCached).
        let orderParam = feedSortKey.isServerSort ? feedSortDirection.rawValue : SortDirection.descending.rawValue
        let page = currentPage
        let offsetParam = page > 0 ? page * pageLimit : nil
        do {
            async let bootstrapTask = api.bootstrap()
            // One page of the current window/sort — not a multi-page
            // historical crawl. Users change the window/page-size/page
            // controls if they want a different slice; the list they see is
            // the list we load.
            let response = try await fetchPageWithRetry(
                FeedQuery(
                    limit: pageLimit,
                    since: nil,
                    ticker: tickerParam,
                    // Free-text politician search must use memberName= (LIKE),
                    // not member= (exact filer/bioguide id). CT UX P0.
                    member: nil,
                    memberName: memberNameParam,
                    chamber: chamberParam,
                    type: typeParam,
                    minAmount: minAmountParam,
                    from: from,
                    to: to,
                    sort: "tx_date",
                    order: orderParam,
                    offset: offsetParam
                )
            )
            try replaceCache(with: response)
            feed = response
            if let total = response.total { tradeTotal = total }
            bootstrap = try await bootstrapTask
            lastSuccessfulRefresh = Date()
            isOffline = false
            // Forward watermark only (for optional background catch-up of brand-new rows).
            let filterKey = Self.syncFilterKey(
                chambers: chambers,
                range: selectedTimeRange,
                tradeType: selectedTradeType
            )
            if let cursor = response.cursor { cursorStore.setCursor(cursor, for: filterKey) }
            if signedIn {
                await refreshSignedInState()
                await PushNotificationManager.shared.syncTokenWithBackend(api: api)
            } else {
                subscriptions = []
                commands = []
                watchlist = []
            }
        } catch {
            if Task.isCancelled { /* superseding refresh / view teardown */ }
            else if let apiError = error as? APIError, apiError.isCancellation {
                // Normal Task cancel — do not paint a grey "cancelled" banner.
            } else {
                isOffline = (error as? APIError)?.isOffline == true
                feedNotice = isOffline
                    ? "Offline. Showing saved trades from this device."
                    : error.localizedDescription
            }
        }
        isRefreshing = false
        if refreshQueued {
            refreshQueued = false
            await refresh()
        }
        // Arm the next foreground poll from this feed's cadence hint. A queued
        // re-refresh above re-enters and re-arms, so this is at most one timer.
        scheduleAutoRefresh()
    }

    func setPartyFilter(_ party: PartyFilter?) async {
        selectedParty = party
        currentPage = 0
        async let r1: Void = refreshTrends()
        async let r2: Void = refresh()
        _ = await (r1, r2)
    }

    func refreshTrends() async {
        isLoadingTrends = true
        trendsNotice = nil
        // All-time + calendar-year analytics map through analyticsWindow.
        let analyticsWindow = selectedTimeRange.analyticsWindow
        let partyParam = selectedParty?.rawValue
        let chamberParam = selectedChambers.isEmpty || selectedChambers.count == ChamberFilter.allCases.count
            ? nil
            : selectedChambers.map { $0.rawValue }.sorted().joined(separator: ",")

        do {
            async let summaryTask = api.analyticsSummary(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let tickersTask = api.tickerLeaderboard(window: analyticsWindow, party: partyParam, chamber: chamberParam, rankBy: "volume")
            async let volumeTask = api.volumeOverTime(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let sectorsTask = api.sectorFlow(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let membersTask = api.memberLeaderboard(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let clustersTask = api.clusterBuys(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let trendingTask = api.trending(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let topPerformersTask = api.topPerformers(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let marketCapTask = api.marketCapBreakdown(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let partySplitTask = api.partySplit(window: analyticsWindow, chamber: chamberParam)
            async let filingLagTask = api.filingLag(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            // Latency is independent of trends filters; load it fail-soft so a
            // slow/failed scoreboard never blanks the rest of Trends.
            async let latencyTask = api.latencySummary()

            analyticsSummary = try await summaryTask
            tickerLeaderboard = try await tickersTask.tickers
            volumeSeries = try await volumeTask.series
            sectorFlow = try await sectorsTask.sectors
            memberLeaderboard = try await membersTask.members
            clusterBuys = try await clustersTask.clusters
            trendingAssets = (try? await trendingTask)?.trending ?? []
            topPerformers = (try? await topPerformersTask)?.members ?? []
            marketCapBuckets = (try? await marketCapTask)?.buckets ?? []
            partySplit = try? await partySplitTask
            filingLag = try? await filingLagTask
            do {
                latencySummary = try await latencyTask
            } catch {
                if let apiError = error as? APIError, apiError.isCancellation {
                    // ignore
                } else {
                    latencySummary = nil
                }
            }
        } catch {
            if Task.isCancelled { /* ignore */ }
            else if let apiError = error as? APIError, apiError.isCancellation {
                // Normal Task cancel — do not paint a grey "cancelled" banner.
            } else {
                trendsNotice = error.localizedDescription
            }
        }
        isLoadingTrends = false
    }

    private func fetchPageWithRetry(_ query: FeedQuery) async throws -> ClientFeedResponse {
        var attempt = 0
        while true {
            do {
                return try await api.feed(query: query)
            } catch let error as APIError {
                attempt += 1
                guard error.isRetryable, attempt < Self.maxAttemptsPerPage else { throw error }
                let backoffSeconds = error.retryAfterSeconds.map(Double.init) ?? pow(2.0, Double(attempt))
                guard backoffSeconds <= 15.0 else { throw error }
                await sleeper(backoffSeconds)
            }
        }
    }

    /// Replace the local cache with the snapshot we just fetched so the list
    /// matches the active window/sort instead of mixing in stale all-time rows.
    /// Upserts by `id` inside a single `save()` instead of the old
    /// delete-everything/re-insert churn (which rewrote every row on every
    /// poll and left the store empty between the delete and the insert).
    private func replaceCache(with response: ClientFeedResponse) throws {
        guard let context = modelContext else { return }
        let existing = try context.fetch(FetchDescriptor<ClientTrade>())
        let byID = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        for item in response.items {
            seen.insert(item.id)
            if let cached = byID[item.id] {
                cached.apply(item)
            } else {
                context.insert(item)
            }
        }
        for trade in existing where !seen.contains(trade.id) {
            context.delete(trade)
        }
        if context.hasChanges {
            try context.save()
        }
        try trimCache(in: context)
    }

    /// Confirms a cached trade is still live; removes it locally and returns
    /// `true` if the server reports it retracted (404 on `GET /trade/:id`).
    @discardableResult
    func reconcileIfDeprecated(_ trade: ClientTrade) async -> Bool {
        do {
            let stillExists = try await api.tradeStillExists(id: trade.id)
            guard !stillExists else { return false }
            if let context = modelContext {
                context.delete(trade)
                try? context.save()
            }
            feedNotice = "A disclosure you had open was retracted by its source and removed from your feed."
            return true
        } catch {
            return false
        }
    }

    private static func syncFilterKey(
        chambers: Set<ChamberFilter>,
        range: TimeRange,
        tradeType: TradeTypeFilter = .all
    ) -> String {
        let chamberKey = (chambers.isEmpty ? initialChambers : chambers)
            .map(\.rawValue)
            .sorted()
            .joined(separator: ",")
        return "\(chamberKey)|\(range.rawValue)|\(tradeType.rawValue)"
    }

    /// The `chamber=` query value for a selection, or `nil` to omit the
    /// parameter entirely when the selection matches the backend's true default.
    private static func chamberQueryValue(for chambers: Set<ChamberFilter>) -> String? {
        // Empty (or all three) = omit chamber= so unresolved-chamber rows stay in view.
        let all = Set(ChamberFilter.allCases)
        if chambers.isEmpty || chambers == all { return nil }
        return chambers.map(\.rawValue).sorted().joined(separator: ",")
    }

    private func trimCache(in context: ModelContext) throws {
        // After replaceCache the store holds one windowed snapshot; cursor-desc
        // is a fine eviction order (newest inserts keep). Display sort is by
        // trade date in the view layer.
        var descriptor = FetchDescriptor<ClientTrade>(
            sortBy: [SortDescriptor(\.cursor, order: .reverse)]
        )
        descriptor.fetchOffset = cacheLimit
        for trade in try context.fetch(descriptor) {
            context.delete(trade)
        }
        if context.hasChanges {
            try context.save()
        }
    }

    // MARK: - People directory (owner punch list #2, item 9)

    /// Loads the `GET /api/members` roster. Memoized for `membersCacheTTL`
    /// (mirrors the web's `PEOPLE_CACHE`/`PEOPLE_TTL_MS`, `dashboardHtml.ts`)
    /// so switching to the People tab repeatedly doesn't re-fetch the whole
    /// roster every time; pass `force: true` for pull-to-refresh.
    func loadMembersDirectory(force: Bool = false) async {
        if !force, let lastLoadedAt = membersLastLoadedAt,
           Date().timeIntervalSince(lastLoadedAt) < Self.membersCacheTTL, !members.isEmpty {
            return
        }
        isLoadingMembers = true
        membersNotice = nil
        do {
            let response = try await api.membersDirectory()
            members = response.members
            membersLastLoadedAt = Date()
        } catch {
            if let apiError = error as? APIError, apiError.isCancellation {
                // ignore
            } else {
                membersNotice = error.localizedDescription
            }
        }
        isLoadingMembers = false
    }

    func refreshSignedInState() async {
        do {
            async let subscriptionsTask = api.subscriptions()
            async let commandsTask = api.commands(limit: 12)
            async let preferencesTask = api.preferences()
            subscriptions = try await subscriptionsTask.subscriptions
            commands = try await commandsTask.commands
            watchlist = try await preferencesTask.preferences.watchlist
        } catch {
            if signedIn {
                commandNotice = error.localizedDescription
            }
        }
    }

    func saveWatchlist(_ text: String) async {
        let tickers = Self.parseTickers(text)

        let mutation = pendingWatchlistMutation?.tickers == tickers
            ? pendingWatchlistMutation!
            : PendingWatchlistMutation(tickers: tickers, idempotencyKey: UUID().uuidString)
        pendingWatchlistMutation = mutation
        isSavingWatchlist = true
        watchlistNotice = nil
        do {
            let response = try await api.updatePreferences(
                tickers: tickers,
                idempotencyKey: mutation.idempotencyKey
            )
            pendingWatchlistMutation = nil
            lastCommand = response.command
            watchlist = response.result?.preferences.watchlist ?? tickers
            watchlistNotice = response.replayed == true ? "Preferences already saved." : "Watchlist saved."
            await refreshCommandHistory()
        } catch {
            watchlistNotice = "Could not save. Retry will safely reuse this request: \(error.localizedDescription)"
        }
        isSavingWatchlist = false
    }

    func createDelivery(mode: DeliveryMode, webhookURL: String, chambers: Set<ChamberFilter> = [], members: [String] = []) async {
        let normalizedURL = webhookURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let filters = SubscriptionFilters(
            members: members.isEmpty ? nil : members,
            tickers: watchlist.isEmpty ? nil : watchlist,
            chambers: chambers.isEmpty ? nil : chambers.map(\.rawValue).sorted()
        )
        let mutation = PendingDeliveryMutation(
            mode: mode,
            webhookURL: normalizedURL,
            filters: filters,
            idempotencyKey: UUID().uuidString
        )
        let request = pendingDeliveryMutation?.matches(mutation) == true ? pendingDeliveryMutation! : mutation
        pendingDeliveryMutation = request
        isCreatingDelivery = true
        deliveryNotice = nil
        do {
            let response: ClientCommandResponse<SubscriptionCommandResult>
            switch mode {
            case .sse:
                response = try await api.createSSESubscription(
                    filters: filters,
                    idempotencyKey: request.idempotencyKey
                )
            case .webhook:
                guard URL(string: normalizedURL)?.scheme?.lowercased() == "https" else {
                    deliveryNotice = "Webhook URLs must use HTTPS."
                    isCreatingDelivery = false
                    return
                }
                response = try await api.createWebhookSubscription(
                    targetURL: normalizedURL,
                    filters: filters,
                    idempotencyKey: request.idempotencyKey
                )
            }
            pendingDeliveryMutation = nil
            lastCommand = response.command
            if let subscription = response.result?.subscription {
                pendingDeliveryCredential = DeliveryCredential(
                    id: subscription.id,
                    delivery: subscription.delivery,
                    streamURL: api.absoluteClientURL(subscription.streamUrl),
                    secret: subscription.secret
                )
            }
            deliveryNotice = response.replayed == true
                ? "Delivery already created. A replay cannot reveal its one-time secret."
                : "Delivery created. Save the credential shown now."
            await refreshSignedInState()
        } catch {
            deliveryNotice = "Could not create delivery. Retry will safely reuse this request: \(error.localizedDescription)"
        }
        isCreatingDelivery = false
    }

    func clearPendingDeliveryCredential() {
        pendingDeliveryCredential = nil
    }

    func toggleSubscription(_ subscription: Subscription) async {
        let desiredActive = !subscription.active
        let previous = pendingSubscriptionMutations[subscription.id]
        let mutation = previous?.active == desiredActive
            ? previous!
            : PendingSubscriptionMutation(active: desiredActive, idempotencyKey: UUID().uuidString)
        pendingSubscriptionMutations[subscription.id] = mutation
        subscriptionIDsInFlight.insert(subscription.id)
        deliveryNotice = nil
        do {
            let response = try await api.setSubscriptionActive(
                id: subscription.id,
                active: desiredActive,
                idempotencyKey: mutation.idempotencyKey
            )
            pendingSubscriptionMutations[subscription.id] = nil
            lastCommand = response.command
            if let updated = response.result?.subscription,
               let index = subscriptions.firstIndex(where: { $0.id == updated.id }) {
                subscriptions[index] = updated
            } else {
                await refreshSignedInState()
            }
            deliveryNotice = desiredActive ? "Delivery resumed." : "Delivery paused."
        } catch {
            deliveryNotice = "Could not update delivery. Retry will safely reuse this request: \(error.localizedDescription)"
        }
        subscriptionIDsInFlight.remove(subscription.id)
    }

    /// Permanently removes a delivery subscription after the UI double-confirm.
    func deleteSubscription(_ subscription: Subscription) async {
        subscriptionIDsInFlight.insert(subscription.id)
        deliveryNotice = nil
        let key = UUID().uuidString
        do {
            let response = try await api.deleteSubscription(id: subscription.id, idempotencyKey: key)
            lastCommand = response.command
            subscriptions.removeAll { $0.id == subscription.id }
            deliveryNotice = "Delivery deleted."
        } catch {
            deliveryNotice = "Could not delete delivery: \(error.localizedDescription)"
            await refreshSignedInState()
        }
        subscriptionIDsInFlight.remove(subscription.id)
    }

    /// Premium CSV export using explicit From/To (export popup) plus active
    /// feed filters. Returns raw CSV bytes for share-sheet handoff.
    func exportCSV(from: String?, to: String?) async throws -> Data {
        guard signedIn else {
            throw APIError.server(status: 401, message: "Sign in required for CSV export", retryAfterSeconds: nil)
        }
        guard isPremium else {
            throw APIError.server(status: 402, message: "CSV export requires Premium", retryAfterSeconds: nil)
        }
        let chamberParam = Self.chamberQueryValue(for: selectedChambers)
        return try await api.exportTransactionsCSV(
            from: from,
            to: to,
            ticker: assetFilter.isEmpty ? nil : assetFilter,
            memberName: politicianFilter.isEmpty ? nil : politicianFilter,
            chamber: chamberParam,
            type: selectedTradeType.queryValue,
            minAmount: selectedAmountThreshold.queryValue
        )
    }

    @discardableResult
    func saveSessionToken(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            watchlistNotice = "Enter a session token."
            return false
        }
        do {
            try api.tokenStore.save(trimmed)
            hasStoredSessionToken = true
            watchlistNotice = "Signed in."
            Task {
                await refresh()
            }
            return true
        } catch {
            watchlistNotice = "Failed to save session: \(error.localizedDescription)"
            return false
        }
    }

    /// Sends a magic-link sign-in email (`POST /auth/magic/request?client=ios`).
    /// The emailed link deep-links back into the app as
    /// `congresstrade://auth?token=…` (handled by `onOpenURL` in the app root).
    func requestMagicLink(email: String) async {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else {
            watchlistNotice = "Enter your email address."
            return
        }
        do {
            try await api.requestMagicLink(email: trimmed)
            watchlistNotice = "If that email is registered, a sign-in link is on its way."
        } catch {
            watchlistNotice = error.localizedDescription
        }
    }

    func signOut() async {
        guard hasStoredSessionToken, !isLoggingOut else { return }
        isLoggingOut = true
        watchlistNotice = nil
        do {
            try await api.logout()
            try api.tokenStore.clear()
            hasStoredSessionToken = false
            bootstrap = nil
            subscriptions = []
            commands = []
            watchlist = []
            watchlistNotice = "Signed out."
            await refresh()
        } catch {
            // Still clear local token so the UI doesn't stay half-signed-in.
            try? api.tokenStore.clear()
            hasStoredSessionToken = false
            bootstrap = nil
            subscriptions = []
            commands = []
            watchlist = []
            watchlistNotice = "Signed out locally. Server revoke may have failed: \(error.localizedDescription)"
        }
        isLoggingOut = false
    }

    private func refreshCommandHistory() async {
        do {
            commands = try await api.commands(limit: 12).commands
        } catch {
            commandNotice = error.localizedDescription
        }
    }
}

private struct PendingWatchlistMutation {
    let tickers: [String]
    let idempotencyKey: String
}

private struct PendingDeliveryMutation {
    let mode: DeliveryMode
    let webhookURL: String
    let filters: SubscriptionFilters
    let idempotencyKey: String

    func matches(_ other: PendingDeliveryMutation) -> Bool {
        mode == other.mode && webhookURL == other.webhookURL && filters == other.filters
    }
}

private struct PendingSubscriptionMutation {
    let active: Bool
    let idempotencyKey: String
}

enum DeliveryMode: String, CaseIterable, Identifiable {
    case sse = "SSE"
    case webhook = "Webhook"

    var id: String { rawValue }
}
