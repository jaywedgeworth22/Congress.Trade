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
                Task { await refresh() }
            }
        }
    }
    /// Canonical chamber chip selection. Drives both the visible chips and
    /// the `chamber=` feed request — see `chamberQueryValue`. CT-AUD-010.
    /// Empty set = no chamber filter (all branches). Mirrors the website HSP chips
    /// where nothing selected means all. Non-empty = filter to that subset.
    @Published private(set) var selectedChambers: Set<ChamberFilter> = Set(ChamberFilter.allCases)
    /// Time window for the feed + trends (website default = Past 3 Months).
    @Published private(set) var selectedTimeRange: TimeRange = .ninetyDays

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
    /// The backend's true default view when `chamber` is omitted entirely:
    /// congressional chambers, excluding Executive (OGE 278-T) disclosures
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
        await refresh()
    }

    func setTimeRange(_ range: TimeRange) async {
        guard range != selectedTimeRange else { return }
        selectedTimeRange = range
        await refresh()
    }

    /// Applies a server-side search filter (submit path; typing alone keeps
    /// using the local debounced cache filter). `nil`/empty clears it.
    func setSearch(_ term: String?) async {
        let trimmed = (term ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let next = trimmed.isEmpty ? nil : trimmed
        guard next != searchTerm else { return }
        searchTerm = next
        await refresh()
    }

    /// Short all-caps tokens are treated as ticker symbols (`ticker=`);
    /// anything longer or with spaces goes to the member filter (`member=`).
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
        let search = searchTerm
        do {
            async let bootstrapTask = api.bootstrap()
            // Single newest-first snapshot for the visible window — not a
            // multi-page historical crawl. Users change the window dropdown
            // if they want a longer range; the list they see is the list we load.
            let response = try await fetchPageWithRetry(
                FeedQuery(
                    limit: pageLimit,
                    since: nil,
                    ticker: search.flatMap { Self.looksLikeTicker($0) ? $0.uppercased() : nil },
                    member: search.flatMap { Self.looksLikeTicker($0) ? nil : $0 },
                    chamber: chamberParam,
                    from: from,
                    sort: "tx_date",
                    order: "desc"
                )
            )
            try replaceCache(with: response)
            feed = response
            if let total = response.total { tradeTotal = total }
            bootstrap = try await bootstrapTask
            lastSuccessfulRefresh = Date()
            isOffline = false
            // Forward watermark only (for optional background catch-up of brand-new rows).
            let filterKey = Self.syncFilterKey(chambers: chambers, range: selectedTimeRange)
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
            isOffline = (error as? APIError)?.isOffline == true
            feedNotice = isOffline
                ? "Offline. Showing saved trades from this device."
                : error.localizedDescription
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

    func refreshTrends() async {
        isLoadingTrends = true
        trendsNotice = nil
        let window = selectedTimeRange == .all ? "all" : selectedTimeRange.rawValue
        // All-time analytics is expensive and some endpoints expect a window;
        // map "all" to a long window for scoreboard parity.
        let analyticsWindow = selectedTimeRange == .all ? "1825d" : window
        do {
            async let summaryTask = api.analyticsSummary(window: analyticsWindow)
            async let tickersTask = api.tickerLeaderboard(window: analyticsWindow, rankBy: "volume")
            async let volumeTask = api.volumeOverTime(window: analyticsWindow)
            async let sectorsTask = api.sectorFlow(window: analyticsWindow)
            async let membersTask = api.memberLeaderboard(window: analyticsWindow)
            async let clustersTask = api.clusterBuys(window: analyticsWindow)
            async let latencyTask = api.latencySummary()

            analyticsSummary = try await summaryTask
            tickerLeaderboard = try await tickersTask.tickers
            volumeSeries = try await volumeTask.series
            sectorFlow = try await sectorsTask.sectors
            memberLeaderboard = try await membersTask.members
            clusterBuys = try await clustersTask.clusters
            latencySummary = try await latencyTask
        } catch {
            trendsNotice = error.localizedDescription
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

    private static func syncFilterKey(chambers: Set<ChamberFilter>, range: TimeRange) -> String {
        let chamberKey = (chambers.isEmpty ? initialChambers : chambers)
            .map(\.rawValue)
            .sorted()
            .joined(separator: ",")
        return "\(chamberKey)|\(range.rawValue)"
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
