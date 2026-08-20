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
    @Published private(set) var conflicts: [ConflictCandidateItem] = []
    /// Multi-select party filter (owner directive 2026-08-09: Chamber/Party/
    /// Trade Type pills must support one-or-many, matching the web's CSV
    /// multi-select semantics). Empty = all parties (default). Forwarded as
    /// `party=` CSV on the feed and on Trends analytics.
    @Published private(set) var selectedParties: Set<PartyFilter> = []
    @Published private(set) var isLoadingTrends = false
    /// TRUE from the instant the user touches a filter control until the rows
    /// that change produced are on screen — deliberately spanning the view's
    /// debounce window, the request itself, and any coalesced re-run.
    ///
    /// WHY THIS IS NOT `isRefreshing`. A filter change takes 3-5s end to end,
    /// and across that window `isRefreshing` is not a trustworthy signal:
    /// it is false during the view's debounce (nothing has been requested
    /// yet), it can drop between two coalesced passes of what the user
    /// experienced as one action, and a chamber/party change fans out to two
    /// independent requests (`refresh()` for Trades, `refreshTrends()` for
    /// Trends) that finish at different times. Binding the "still working"
    /// indicator here is the only way it stays lit for the whole wait — which
    /// is exactly the "so you don't think that it just isn't working"
    /// feedback the owner asked for.
    @Published private(set) var isApplyingFilters = false
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
    /// Page size for the visible feed snapshot (newest first). Not a multi-page
    /// crawl. `private(set)` with `setPageSize(_:)` as the only mutator: the old
    /// `didSet` fired a detached `Task { await refresh() }`, so nobody could
    /// await a page-size change and the "updating" indicator had no way to
    /// cover it.
    @Published private(set) var viewLimit: Int = 50
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
    /// Multi-select Buy/Sell/Exchange side filter. Empty = all sides. Forwarded
    /// as `type=` CSV when a subset is selected (`asTxTypes`).
    @Published private(set) var selectedTradeTypes: Set<TradeTypeFilter> = []
    /// Trades-only free-text politician filter (`memberName=`).
    @Published private(set) var politicianFilter: String = ""
    /// Trades-only asset/ticker filter (`ticker=`).
    @Published private(set) var assetFilter: String = ""
    /// Trades-only instrument class (`assetClass=`). Default All.
    @Published private(set) var selectedAssetClass: AssetClassFilter = .all

    @Published var isLoadingMore = false

    /// Last successful `GET /auth/me` with `admin.allowed`.
    @Published private(set) var adminAccessGranted = false
    @Published private(set) var isProbingAdmin = false
    @Published private(set) var isLoadingAdmin = false
    @Published private(set) var isLoadingReviewQueue = false
    @Published private(set) var adminNotice: String?
    @Published private(set) var publicHealth: PublicHealthResponse?
    @Published private(set) var pollingHealth: PollingHealthResponse?
    @Published private(set) var autopilotStatus: AutopilotStatusResponse?
    @Published private(set) var reviewQueueItems: [ReviewQueueItem] = []
    @Published private(set) var reviewQueueTotals: ReviewQueueTotals?
    @Published private(set) var reviewQueueNextCursor: String?
    @Published private(set) var reviewQueueShowsResolved = false
    @Published private(set) var reviewExtractions: [String: ReviewExtractionsResponse] = [:]
    @Published private(set) var reviewActionDocId: String?

    var modelContext: ModelContext?

    internal let api: CongressTradeAPIClient
    private let tokenStore = KeychainTokenStore()
    private let cursorStore: SyncCursorStore
    private let sleeper: (Double) async -> Void
    private var pendingWatchlistMutation: PendingWatchlistMutation?
    private var pendingDeliveryMutation: PendingDeliveryMutation?
    private var pendingSubscriptionMutations: [String: PendingSubscriptionMutation] = [:]
    /// Set when a `refresh()` is requested while one is already running (e.g.
    /// the user toggles chambers mid catch-up). The active runner picks it up
    /// and makes one more pass against the latest selection before finishing,
    /// so a filter change is never dropped — see `refresh()`.
    private var refreshRequested = false
    /// The single in-flight refresh loop, if any. Every caller of `refresh()`
    /// awaits *this*, so `await refresh()` means "the feed now reflects my
    /// change", not "someone else's request happened to be running".
    private var refreshRunner: Task<Void, Never>?
    /// Same request/runner pair for the Trends analytics fan-out.
    private var trendsRequested = false
    private var trendsRunner: Task<Void, Never>?
    /// Filter edits the user has made that have not yet reached a request —
    /// i.e. we are inside a view-side debounce window.
    private var pendingFilterIntents = 0
    /// Filter-driven refreshes currently running (or queued for a coalesced
    /// re-run). Nested, because one filter change fans out to both tabs.
    private var filterApplyDepth = 0
    /// Fail-safe for `pendingFilterIntents`: a view that opens an intent and
    /// then never lands a store mutation (its debounced edit turned out to be
    /// local-search-only, say) must not be able to strand the indicator on.
    private var filterIntentWatchdog: Task<Void, Never>?
    private static let filterIntentWatchdogSeconds: UInt64 = 8
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

    /// Admin hamburger row — hidden unless `GET /auth/me` reports `admin.allowed`.
    var showsAdminRow: Bool { adminAccessGranted }

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

    /// `"stripe" | "apple" | nil` — which billing surface currently backs
    /// Premium, for choosing between the App Store subscriptions page and the
    /// Stripe billing portal link. Additive/optional on the server
    /// (`app/docs/client-mobile-api.md` "Entitlement semantics"); `nil` means
    /// "unknown," not "not premium" — always gate visibility on `isPremium`.
    var entitlementSource: String? {
        bootstrap?.auth.entitlement.source
    }

    static func parseTickers(_ text: String) -> [String] {
        text
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
            .filter { !$0.isEmpty }
    }

    // MARK: - Filter-pending indicator

    /// Call the moment the user touches a filter control — BEFORE any
    /// view-side debounce — so the "updating" indicator lights immediately
    /// instead of after the debounce has already burned half the wait.
    ///
    /// Must be balanced by `endFilterChange()` when the debounce fires,
    /// whether or not it ends up calling a store setter (a purely local search
    /// narrowing never does). Landing a real filter setter also clears every
    /// open intent, and the watchdog clears them after
    /// `filterIntentWatchdogSeconds` regardless: a briefly dark indicator is a
    /// far cheaper bug than a spinner that never stops.
    func beginFilterChange() {
        pendingFilterIntents += 1
        armFilterIntentWatchdog()
        syncIsApplyingFilters()
    }

    /// Balances `beginFilterChange()`. Safe to over-call.
    func endFilterChange() {
        guard pendingFilterIntents > 0 else { return }
        pendingFilterIntents -= 1
        if pendingFilterIntents == 0 {
            filterIntentWatchdog?.cancel()
            filterIntentWatchdog = nil
        }
        syncIsApplyingFilters()
    }

    private func clearFilterIntents() {
        guard pendingFilterIntents > 0 else { return }
        pendingFilterIntents = 0
        filterIntentWatchdog?.cancel()
        filterIntentWatchdog = nil
        syncIsApplyingFilters()
    }

    private func armFilterIntentWatchdog() {
        filterIntentWatchdog?.cancel()
        filterIntentWatchdog = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.filterIntentWatchdogSeconds * 1_000_000_000)
            guard !Task.isCancelled, let self, self.pendingFilterIntents > 0 else { return }
            self.pendingFilterIntents = 0
            self.syncIsApplyingFilters()
        }
    }

    private func syncIsApplyingFilters() {
        let next = pendingFilterIntents > 0 || filterApplyDepth > 0
        if next != isApplyingFilters { isApplyingFilters = next }
    }

    /// Runs a filter mutation with the indicator held up for its whole life,
    /// including both fan-out requests. The mutation subsumes any open
    /// debounce-window intents, which is what makes the counter self-healing.
    private func applyingFilterChange(_ body: () async -> Void) async {
        // Raise the depth FIRST, then drop the debounce-window intents this
        // mutation subsumes: with the depth already up, clearing them
        // recomputes to the same `true`, so the flag cannot blink off between
        // the two.
        filterApplyDepth += 1
        clearFilterIntents()
        syncIsApplyingFilters()
        await body()
        filterApplyDepth -= 1
        syncIsApplyingFilters()
    }

    // MARK: - Filter setters

    /// Selects the chamber chips and immediately resyncs against that
    /// selection's own request. An empty selection is legal and means "all
    /// branches", matching the website's unselected H/S/P chips.
    func setChamberSelection(_ chambers: Set<ChamberFilter>) async {
        await applyingFilterChange {
            // Allow empty = all branches (website parity with unselected H/S/P).
            selectedChambers = chambers
            currentPage = 0
            async let r1: Void = refresh()
            async let r2: Void = refreshTrends()
            _ = await (r1, r2)
        }
    }

    func setTimeRange(_ range: TimeRange) async {
        guard range != selectedTimeRange else {
            clearFilterIntents()
            return
        }
        await applyingFilterChange {
            selectedTimeRange = range
            currentPage = 0
            async let r1: Void = refresh()
            async let r2: Void = refreshTrends()
            _ = await (r1, r2)
        }
    }

    /// Sets the full Buy/Sell/Exchange multi-selection and immediately
    /// resyncs. Empty = all sides.
    func setTradeTypeSelection(_ types: Set<TradeTypeFilter>) async {
        guard types != selectedTradeTypes else {
            clearFilterIntents()
            return
        }
        await applyingFilterChange {
            selectedTradeTypes = types
            currentPage = 0
            async let r1: Void = refresh()
            async let r2: Void = refreshTrends()
            _ = await (r1, r2)
        }
    }

    /// Trades-only politician name filter (server `memberName=`).
    func setPoliticianFilter(_ text: String) async {
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard next != politicianFilter else {
            clearFilterIntents()
            return
        }
        await applyingFilterChange {
            politicianFilter = next
            currentPage = 0
            await refresh()
        }
    }

    /// Trades-only asset/ticker filter (server `ticker=`).
    func setAssetFilter(_ text: String) async {
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard next != assetFilter else {
            clearFilterIntents()
            return
        }
        await applyingFilterChange {
            assetFilter = next
            currentPage = 0
            await refresh()
        }
    }

    // MARK: - Trades sort control (owner punch list #2, item 7)

    /// Selecting Date refetches the current page with `sort=tx_date` in the
    /// existing direction; selecting Amount is a local re-sort only (no
    /// backend `amount` sort key — see `FeedSortKey.isServerSort`).
    func setFeedSortKey(_ key: FeedSortKey) async {
        guard key != feedSortKey else {
            clearFilterIntents()
            return
        }
        await applyingFilterChange {
            feedSortKey = key
            guard key.isServerSort else { return }
            currentPage = 0
            await refresh()
        }
    }

    /// Flips asc/desc for whichever sort key is active. Only a server-sort
    /// key (currently Date) needs a refetch; Amount just re-renders the
    /// already-loaded page in the new direction.
    func toggleFeedSortDirection() async {
        await applyingFilterChange {
            feedSortDirection = feedSortDirection.toggled
            guard feedSortKey.isServerSort else { return }
            currentPage = 0
            await refresh()
        }
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
        await applyingFilterChange {
            currentPage += 1
            await refresh()
        }
    }

    func goToPreviousPage() async {
        guard canGoToPreviousPage else { return }
        await applyingFilterChange {
            currentPage -= 1
            await refresh()
        }
    }

    /// Rows-per-page control — the one mutator of `viewLimit`.
    func setPageSize(_ size: Int) async {
        guard size != viewLimit else {
            clearFilterIntents()
            return
        }
        await applyingFilterChange {
            viewLimit = size
            // A different page size shifts every page boundary — land on a
            // page that is guaranteed to exist under the new size.
            currentPage = 0
            await refresh()
        }
    }

    // MARK: - "Updating" indicator inputs

    /// Whether the Trades list is currently being recomputed — a filter change
    /// (including its debounce window), a sort change, a page turn, or a poll.
    var isTradesUpdating: Bool { isApplyingFilters || isRefreshing }

    // MARK: - Truthful trade count

    /// Whether the visible list is narrowed by something the SERVER never saw,
    /// which makes `tradeTotal` an overstatement of what is actually shown.
    ///
    /// The only remaining client-only narrowing is local search text — party
    /// and multi-side now go to the server as CSV, so `tradeTotal` matches.
    func hasClientOnlyNarrowing(localSearchText: String = "") -> Bool {
        !localSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The only count the Trades header is allowed to print.
    ///
    /// The header used to show `filteredTrades.count`, which under the default
    /// 100-row page size is the PAGE SIZE and not a count of anything — hence
    /// the owner seeing a permanent "100". This never returns a page limit
    /// dressed up as a total, and never invents one either.
    ///
    /// - Parameters:
    ///   - visibleCount: rows the view is actually rendering, after its own
    ///     client-side predicates.
    ///   - localSearchText: the view's live search text (see
    ///     `hasClientOnlyNarrowing`).
    func tradeCountSummary(visibleCount: Int, localSearchText: String = "") -> TradeCountSummary {
        guard feed != nil else { return .unknown }
        guard hasClientOnlyNarrowing(localSearchText: localSearchText) else {
            // Every active filter is one the server applied, so its COUNT(*)
            // describes exactly this result set — including a truthful zero,
            // which the `feed != nil` guard above separates from "not loaded".
            return .total(tradeTotal)
        }
        // Client-only narrowing normally makes a true total unknowable: the
        // local predicate only ever sees the loaded page. The one exception is
        // a result set that already fits inside a single page — then the page
        // IS the whole set, so counting it locally is exact rather than a page
        // artifact.
        if currentPage == 0, tradeTotal > 0, tradeTotal <= pageLimit {
            return .total(visibleCount)
        }
        return .narrowed(visible: visibleCount)
    }

    /// Applies a server-side search filter (submit path; typing alone keeps
    /// using the local debounced cache filter). `nil`/empty clears it.
    /// Prefer `setPoliticianFilter` / `setAssetFilter` for dedicated fields.
    func setSearch(_ term: String?) async {
        let trimmed = (term ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let next = trimmed.isEmpty ? nil : trimmed
        guard next != searchTerm else {
            clearFilterIntents()
            return
        }
        await applyingFilterChange {
            searchTerm = next
            currentPage = 0
            await refresh()
        }
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

    /// Resyncs the Trades feed against the CURRENT filter selection, and does
    /// not return until that has actually happened.
    ///
    /// COALESCE, NEVER DROP. The old shape was
    /// `guard !isRefreshing else { refreshQueued = true; return }`, which made
    /// `await refresh()` a lie whenever a request was already in flight: the
    /// call returned immediately, so a filter setter awaiting it finished
    /// while the screen still showed the *previous* filter's rows, and every
    /// caller keyed off `isRefreshing` — a flag about someone else's request.
    /// With a 3-5s round trip and an auto-poll timer running, that is easy to
    /// hit just by toggling a chip at the wrong moment, and the symptom is
    /// precisely the owner's "it just isn't working".
    ///
    /// Now there is one runner loop: callers mark a request and await the
    /// runner, the runner re-runs while requests keep arriving, and it clears
    /// itself only after a pass during which none did. Every `await refresh()`
    /// — the first caller, a caller that arrived mid-flight, the auto-poll —
    /// returns with the newest selection already applied. Coalescing is
    /// bounded: N requests during one pass collapse into exactly one extra
    /// pass, and because this is a loop rather than the previous tail-recursive
    /// re-entry there is no call-stack growth under a burst of chip taps.
    ///
    /// The check/clear sequence at the bottom of the loop needs no lock: the
    /// class is `@MainActor`, and between the failing `while` test and
    /// `refreshRunner = nil` there is no suspension point, so no caller can
    /// observe a live-but-finished runner and have its request dropped.
    func refresh() async {
        refreshRequested = true
        // Held across the whole coalesced sequence rather than per pass, so an
        // indicator bound to it cannot blink off between two passes of what the
        // user experienced as a single action.
        isRefreshing = true
        if let runner = refreshRunner {
            await runner.value
            return
        }
        let runner = Task { @MainActor [weak self] in
            guard let self else { return }
            while self.refreshRequested {
                self.refreshRequested = false
                await self.performRefresh()
            }
            self.refreshRunner = nil
            self.isRefreshing = false
        }
        refreshRunner = runner
        await runner.value
    }

    private func performRefresh() async {
        feedNotice = nil
        let chambers = selectedChambers
        let chamberParam = Self.chamberQueryValue(for: chambers)
        let from = selectedTimeRange.fromDateISO
        let to = selectedTimeRange.toDateISO
        let search = searchTerm
        let typeParam = Self.tradeTypeQueryValue(for: selectedTradeTypes)
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
                    party: Self.partyQueryValue(for: selectedParties),
                    assetClass: selectedAssetClass.queryValue,
                    from: from,
                    to: to,
                    sort: "tx_date",
                    order: orderParam,
                    offset: offsetParam
                )
            )
            try replaceCache(with: response)
            feed = response
            // `total` is the server's COUNT(*) over the SERVER-side filters,
            // independent of limit/offset (`readClientTradeList`), so it is a
            // real total and not the page size. It is omitted only on a
            // zero-delta `?since=` poll, which this store never sends — hence
            // the plain `if let` rather than a reset to 0, which would blank a
            // valid count if the server ever started omitting it.
            if let total = response.total { tradeTotal = total }
            bootstrap = try await bootstrapTask
            lastSuccessfulRefresh = Date()
            isOffline = false
            // Forward watermark only (for optional background catch-up of brand-new rows).
            let filterKey = Self.syncFilterKey(
                chambers: chambers,
                range: selectedTimeRange,
                tradeTypes: selectedTradeTypes
            )
            if let cursor = response.cursor { cursorStore.setCursor(cursor, for: filterKey) }
            if signedIn {
                await refreshSignedInState()
                await PushNotificationManager.shared.syncTokenWithBackend(api: api)
                await probeAdminAccess()
            } else {
                subscriptions = []
                commands = []
                watchlist = []
                adminAccessGranted = false
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
        // Arm the next foreground poll from this feed's cadence hint. A
        // coalesced re-run calls this again and `scheduleAutoRefresh` cancels
        // the previous timer first, so this is at most one timer.
        scheduleAutoRefresh()
    }

    /// Sets the full party multi-selection and immediately resyncs both the
    /// (client-side-filtered) Trades feed and Trends analytics. Empty = all
    /// parties.
    func setAssetClass(_ filter: AssetClassFilter) async {
        guard filter != selectedAssetClass else {
            clearFilterIntents()
            return
        }
        await applyingFilterChange {
            selectedAssetClass = filter
            currentPage = 0
            await refresh()
        }
    }

    func setPartySelection(_ parties: Set<PartyFilter>) async {
        guard parties != selectedParties else {
            clearFilterIntents()
            return
        }
        await applyingFilterChange {
            selectedParties = parties
            currentPage = 0
            async let r1: Void = refreshTrends()
            async let r2: Void = refresh()
            _ = await (r1, r2)
        }
    }

    /// Resyncs the Trends analytics fan-out, and does not return until that has
    /// happened.
    ///
    /// Serialized by the same runner shape as `refresh()`, for a different
    /// reason: this had NO overlap guard at all, so two filter changes in quick
    /// succession raced one eleven-request fan-out against another. Whichever
    /// finished first cleared `isLoadingTrends` while the other was still
    /// running, and whichever response landed last won each property — so the
    /// board could settle on the OLDER selection's numbers with no spinner and
    /// nothing on screen admitting it. Serializing makes last-write-wins mean
    /// last-*requested*-wins.
    func refreshLatency() async {
        do {
            latencySummary = try await api.latencySummary()
        } catch {
            if let apiError = error as? APIError, apiError.isCancellation {
                return
            }
            // Fail-soft: Delivery/Trends hide the scoreboard when this stays nil.
        }
    }

    func refreshTrends() async {
        trendsRequested = true
        isLoadingTrends = true
        if let runner = trendsRunner {
            await runner.value
            return
        }
        let runner = Task { @MainActor [weak self] in
            guard let self else { return }
            while self.trendsRequested {
                self.trendsRequested = false
                await self.performTrendsRefresh()
            }
            self.trendsRunner = nil
            self.isLoadingTrends = false
        }
        trendsRunner = runner
        await runner.value
    }

    private func performTrendsRefresh() async {
        trendsNotice = nil
        // All-time + calendar-year analytics map through analyticsWindow.
        let analyticsWindow = selectedTimeRange.analyticsWindow
        let partyParam = Self.partyQueryValue(for: selectedParties)
        let chamberParam = selectedChambers.isEmpty || selectedChambers.count == ChamberFilter.allCases.count
            ? nil
            : selectedChambers.map { $0.rawValue }.sorted().joined(separator: ",")
        let typeParam = Self.tradeTypeQueryValue(for: selectedTradeTypes)

        do {
            async let summaryTask = api.analyticsSummary(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam)
            async let tickersTask = api.tickerLeaderboard(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam, sort: "volume")
            async let volumeTask = api.volumeOverTime(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam)
            async let sectorsTask = api.sectorFlow(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam)
            async let membersTask = api.memberLeaderboard(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam)
            async let clustersTask = api.clusterBuys(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam)
            async let trendingTask = api.trending(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam)
            async let topPerformersTask = api.topPerformers(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam)
            async let marketCapTask = api.marketCapBreakdown(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam)
            async let partySplitTask = api.partySplit(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam)
            async let filingLagTask = api.filingLag(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam)
            async let conflictsTask = api.conflicts(window: analyticsWindow, party: partyParam, chamber: chamberParam, type: typeParam)
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
            conflicts = (try? await conflictsTask)?.conflicts ?? []
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
        tradeTypes: Set<TradeTypeFilter> = []
    ) -> String {
        let chamberKey = (chambers.isEmpty ? initialChambers : chambers)
            .map(\.rawValue)
            .sorted()
            .joined(separator: ",")
        let typeKey = tradeTypes.isEmpty ? "all" : tradeTypes.map(\.rawValue).sorted().joined(separator: ",")
        return "\(chamberKey)|\(range.rawValue)|\(typeKey)"
    }

    /// The `chamber=` query value for a selection, or `nil` to omit the
    /// parameter entirely when the selection matches the backend's true default.
    private static func chamberQueryValue(for chambers: Set<ChamberFilter>) -> String? {
        // Empty (or all three) = omit chamber= so unresolved-chamber rows stay in view.
        let all = Set(ChamberFilter.allCases)
        if chambers.isEmpty || chambers == all { return nil }
        return chambers.map(\.rawValue).sorted().joined(separator: ",")
    }

    /// The `type=` query value for a multi-selection. Empty / all sides omit
    /// the param; otherwise send CSV (`B,S`) — `asTxTypes` accepts it.
    private static func tradeTypeQueryValue(for types: Set<TradeTypeFilter>) -> String? {
        let all = Set(TradeTypeFilter.allCases)
        if types.isEmpty || types == all { return nil }
        return types.map(\.rawValue).sorted().joined(separator: ",")
    }

    private static func partyQueryValue(for parties: Set<PartyFilter>) -> String? {
        let all = Set(PartyFilter.allCases)
        if parties.isEmpty || parties == all { return nil }
        return parties.map(\.rawValue).sorted().joined(separator: ",")
    }

    /// Shared chips (window/chamber/party/side) forwarded onto ticker and
    /// politician sheets so those functions honor the same filters as Trends.
    func fetchTicker(_ symbol: String) async throws -> ClientTickerResponse {
        try await api.ticker(
            symbol,
            window: selectedTimeRange.analyticsWindow,
            from: selectedTimeRange.fromDateISO,
            to: selectedTimeRange.toDateISO,
            chamber: Self.chamberQueryValue(for: selectedChambers),
            party: Self.partyQueryValue(for: selectedParties),
            type: Self.tradeTypeQueryValue(for: selectedTradeTypes)
        )
    }

    func fetchMember(id: String) async throws -> ClientMemberResponse {
        try await api.member(
            id: id,
            window: selectedTimeRange.analyticsWindow,
            from: selectedTimeRange.fromDateISO,
            to: selectedTimeRange.toDateISO,
            chamber: Self.chamberQueryValue(for: selectedChambers),
            party: Self.partyQueryValue(for: selectedParties),
            type: Self.tradeTypeQueryValue(for: selectedTradeTypes)
        )
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
            type: Self.tradeTypeQueryValue(for: selectedTradeTypes),
            party: Self.partyQueryValue(for: selectedParties),
            assetClass: selectedAssetClass.queryValue
        )
    }

    /// Shared account-status notice setter for sign-in flows implemented
    /// outside this file (`Store/AppleSignIn.swift`) — `watchlistNotice`
    /// itself stays `private(set)` so every write funnels through this file.
    func setAccountNotice(_ text: String) {
        watchlistNotice = text
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

    func probeAdminAccess() async {
        if isProbingAdmin { return }
        isProbingAdmin = true
        defer { isProbingAdmin = false }
        do {
            let granted = try await api.probeAdminAccess()
            adminAccessGranted = granted
            if !granted {
                publicHealth = nil
                pollingHealth = nil
                autopilotStatus = nil
                reviewQueueItems = []
                reviewQueueTotals = nil
                reviewQueueNextCursor = nil
                reviewExtractions = [:]
            }
        } catch {
            if let apiError = error as? APIError, apiError.isCancellation { return }
            adminAccessGranted = false
        }
    }

    func refreshAdminSurface() async {
        await probeAdminAccess()
        guard adminAccessGranted else { return }
        isLoadingAdmin = true
        defer { isLoadingAdmin = false }
        adminNotice = nil
        do {
            async let healthTask = api.publicHealth()
            async let pollingTask = api.pollingHealth()
            async let autopilotTask = api.autopilotStatus()
            publicHealth = try await healthTask
            pollingHealth = try await pollingTask
            autopilotStatus = try await autopilotTask
        } catch {
            if let apiError = error as? APIError, apiError.isCancellation { return }
            adminNotice = error.localizedDescription
        }
    }

    func refreshReviewQueue(resolved: Bool? = nil) async {
        if let resolved { reviewQueueShowsResolved = resolved }
        await probeAdminAccess()
        guard adminAccessGranted else { return }
        isLoadingReviewQueue = true
        defer { isLoadingReviewQueue = false }
        do {
            let response = try await api.reviewQueue(resolved: reviewQueueShowsResolved, limit: 50)
            reviewQueueItems = response.items
            reviewQueueTotals = response.totals
            reviewQueueNextCursor = response.nextCursor
        } catch {
            if let apiError = error as? APIError, apiError.isCancellation { return }
            adminNotice = error.localizedDescription
        }
    }

    func loadMoreReviewQueue() async {
        guard adminAccessGranted, let cursor = reviewQueueNextCursor, !cursor.isEmpty else { return }
        isLoadingReviewQueue = true
        defer { isLoadingReviewQueue = false }
        do {
            let response = try await api.reviewQueue(
                resolved: reviewQueueShowsResolved,
                limit: 50,
                cursor: cursor
            )
            let existing = Set(reviewQueueItems.map(\.docId))
            reviewQueueItems.append(contentsOf: response.items.filter { !existing.contains($0.docId) })
            reviewQueueTotals = response.totals
            reviewQueueNextCursor = response.nextCursor
        } catch {
            if let apiError = error as? APIError, apiError.isCancellation { return }
            adminNotice = error.localizedDescription
        }
    }

    func loadReviewExtractions(docId: String) async {
        guard adminAccessGranted, !docId.isEmpty else { return }
        do {
            reviewExtractions[docId] = try await api.reviewExtractions(docId: docId)
        } catch {
            if let apiError = error as? APIError, apiError.isCancellation { return }
            adminNotice = error.localizedDescription
        }
    }

    func acknowledgeAutopilotHalt() async {
        guard adminAccessGranted else { return }
        reviewActionDocId = "autopilot-halt"
        defer { reviewActionDocId = nil }
        do {
            _ = try await api.acknowledgeAutopilotHalt()
            adminNotice = "Halt acknowledged.  A new run can start on the next cron tick."
            await refreshAdminSurface()
        } catch {
            adminNotice = error.localizedDescription
        }
    }

    func rejectReviewItem(_ item: ReviewQueueItem) async {
        await mutateReview(docId: item.docId) {
            _ = try await api.reviewDecision(
                docId: item.docId,
                decision: "reject",
                reviewRevision: item.reviewRevision
            )
            adminNotice = "Rejected \(item.docId)."
        }
    }

    func confirmReviewItem(_ item: ReviewQueueItem, edits: [[String: Any]], modelName: String) async {
        guard !edits.isEmpty else {
            adminNotice = "Confirm needs at least one extracted row.  Use Reject to discard this filing."
            return
        }
        await mutateReview(docId: item.docId) {
            _ = try await api.reviewDecision(
                docId: item.docId,
                decision: "confirm",
                reviewRevision: item.reviewRevision,
                edits: edits
            )
            adminNotice = "Confirmed \(item.docId) from \(modelName)."
        }
    }

    func unpublishReviewItem(_ item: ReviewQueueItem) async {
        await mutateReview(docId: item.docId) {
            _ = try await api.unpublishReview(
                docId: item.docId,
                reviewRevision: item.reviewRevision,
                reason: "unpublished from iOS admin"
            )
            adminNotice = "Unpublished \(item.docId).  It is back in the pending queue."
        }
    }

    func retryReviewAuto(_ item: ReviewQueueItem) async {
        await mutateReview(docId: item.docId) {
            _ = try await api.retryReviewAuto(docId: item.docId, reviewRevision: item.reviewRevision)
            adminNotice = "Released the automation hold on \(item.docId)."
        }
    }

    private func mutateReview(docId: String, _ work: () async throws -> Void) async {
        guard adminAccessGranted else { return }
        reviewActionDocId = docId
        defer { reviewActionDocId = nil }
        do {
            try await work()
            await refreshReviewQueue()
            await refreshAdminSurface()
        } catch {
            adminNotice = error.localizedDescription
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
            await probeAdminAccess()
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

/// What the Trades header is allowed to say about "how many trades".
/// Built by `CongressTradeStore.tradeCountSummary(visibleCount:localSearchText:)`
/// — see there for why each case exists. There is deliberately no case for
/// "some number we hope is right".
enum TradeCountSummary: Equatable {
    /// Nothing has loaded yet — print nothing rather than a placeholder zero.
    case unknown
    /// A true count of every trade matching the active filters and search.
    case total(Int)
    /// Client-only narrowing over a result set larger than one page, so only
    /// what is loaded can be counted. Never presented as a total.
    case narrowed(visible: Int)

    /// Ready-to-render text, or `nil` when the honest answer is to show
    /// nothing. Sentence case; thousands separators, never a compacted "1.2k"
    /// — a count the user may reconcile against the pager deserves its digits.
    var label: String? {
        switch self {
        case .unknown:
            return nil
        case .total(let count):
            return count.formatted(.number.grouping(.automatic))
        case .narrowed(let visible):
            return visible == 1 ? "1 shown on this page" : "\(visible.formatted(.number.grouping(.automatic))) shown on this page"
        }
    }
}
