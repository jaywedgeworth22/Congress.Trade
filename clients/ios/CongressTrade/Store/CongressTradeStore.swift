import Foundation
import SwiftData

@MainActor
final class CongressTradeStore: ObservableObject {
    @Published private(set) var bootstrap: BootstrapResponse?
    @Published private(set) var feed: ClientFeedResponse?
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
    /// Canonical chamber chip selection. Drives both the visible chips and
    /// the `chamber=` feed request — see `chamberQueryValue`. CT-AUD-010.
    @Published private(set) var selectedChambers: Set<ChamberFilter> = CongressTradeStore.initialChambers

    var modelContext: ModelContext?

    private let api: CongressTradeAPIClient
    private let cursorStore: SyncCursorStore
    private let sleeper: (Double) async -> Void
    private var pendingWatchlistMutation: PendingWatchlistMutation?
    private var pendingDeliveryMutation: PendingDeliveryMutation?
    private var pendingSubscriptionMutations: [String: PendingSubscriptionMutation] = [:]
    /// Set when a `refresh()` is requested while one is already running (e.g. the
    /// user toggles chambers mid catch-up). The in-flight refresh re-runs once
    /// against the latest `selectedChambers` when it finishes, so a chip change
    /// during a sync never leaves the newly selected filter unsynced.
    private var refreshQueued = false

    private static let cacheLimit = 500
    /// Rows requested per feed page during catch-up sync.
    private static let pageLimit = 50
    /// Hard bound on pages fetched in a single `refresh()` catch-up loop, so a
    /// large backlog can't turn one pull-to-refresh into an unbounded crawl.
    private static let maxCatchUpPages = 20
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

    var entitlementLabel: String {
        bootstrap?.auth.entitlement.premium == true ? "Premium" : "Free"
    }

    static func parseTickers(_ text: String) -> [String] {
        text
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
            .filter { !$0.isEmpty }
    }

    /// Selects the chamber chips and immediately resyncs against that
    /// selection's own request/cursor. Never allows an empty selection (that
    /// would be indistinguishable from "no filter chosen yet"); an attempt to
    /// deselect the last chip resets to the documented default instead.
    func setChamberSelection(_ chambers: Set<ChamberFilter>) async {
        selectedChambers = chambers.isEmpty ? Self.initialChambers : chambers
        await refresh()
    }

    func refresh() async {
        // A refresh requested while one is in flight (a chip toggle during a
        // catch-up loop) is captured here and replayed against the latest
        // selection when the current pass ends, rather than silently dropped.
        guard !isRefreshing else {
            refreshQueued = true
            return
        }
        isRefreshing = true
        feedNotice = nil
        let chambers = selectedChambers
        let filterKey = Self.chamberFilterKey(for: chambers)
        let chamberParam = Self.chamberQueryValue(for: chambers)
        do {
            async let bootstrapTask = api.bootstrap()
            let sync = try await syncFeed(filterKey: filterKey, chamberParam: chamberParam)

            bootstrap = try await bootstrapTask
            if let latest = sync.lastResponse {
                feed = latest
            }
            lastSuccessfulRefresh = Date()
            isOffline = false
            feedNotice = sync.notice
            if signedIn {
                await refreshSignedInState()
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
        // Replay a coalesced request against the now-current selection (a single
        // re-run collapses any number of chip toggles that arrived mid-refresh).
        if refreshQueued {
            refreshQueued = false
            await refresh()
        }
    }

    private struct FeedSyncResult {
        let lastResponse: ClientFeedResponse?
        let notice: String?
    }

    /// Runs the catch-up loop for one filter: resumes from that filter's own
    /// persisted cursor (falling back to whatever's already cached locally on
    /// first run after this feature ships, then a fresh newest-page snapshot
    /// for a brand new install), paginates forward until a page comes back
    /// short of a full page (exhausted) or the bounded page cap is hit, and
    /// retries transient failures with backoff in between. CT-AUD-009.
    private func syncFeed(filterKey: String, chamberParam: String?) async throws -> FeedSyncResult {
        // Only the default (house+senate) filter may resume from the pre-existing
        // local cache: rows cached before per-filter cursors shipped are that
        // default view, so their max cursor is a valid resume point for it alone.
        // Any OTHER filter that has never been synced must cold-start from a fresh
        // newest-page snapshot — seeding it from the default view's watermark
        // would skip every matching row at or below that unrelated cursor.
        let isDefaultFilter = filterKey == Self.chamberFilterKey(for: Self.defaultChambers)
        let resumeCursor = cursorStore.cursor(for: filterKey)
            ?? (isDefaultFilter ? fetchMaxLocalCursor() : nil)
        guard let startingCursor = resumeCursor else {
            // Cold start for this exact filter: bounded newest-page snapshot,
            // not a full historical backfill.
            let response = try await fetchPageWithRetry(
                FeedQuery(limit: Self.pageLimit, since: nil, chamber: chamberParam, order: "desc")
            )
            try persist(response)
            cursorStore.setCursor(response.cursor, for: filterKey)
            return FeedSyncResult(lastResponse: response, notice: nil)
        }

        var cursor = startingCursor
        var lastResponse: ClientFeedResponse?
        var pages = 0
        while pages < Self.maxCatchUpPages {
            let response = try await fetchPageWithRetry(
                FeedQuery(limit: Self.pageLimit, since: cursor, chamber: chamberParam, order: "asc")
            )
            try persist(response)
            pages += 1
            lastResponse = response
            if response.count > 0 {
                cursor = max(cursor, response.cursor)
                cursorStore.setCursor(cursor, for: filterKey)
            }
            // A short page (fewer rows than requested) is the exhaustion
            // signal: the backend already excludes deprecated/retracted rows
            // from this count (`t.deprecated_at IS NULL` is applied before
            // LIMIT), so "short page" reliably means "caught up", not
            // "some rows were skipped".
            if response.count < response.limit {
                return FeedSyncResult(lastResponse: lastResponse, notice: nil)
            }
        }
        return FeedSyncResult(
            lastResponse: lastResponse,
            notice: "Caught up on the latest \(pages * Self.pageLimit) trades. Pull to refresh again to keep catching up."
        )
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

    private func persist(_ response: ClientFeedResponse) throws {
        guard let context = modelContext else { return }
        for item in response.items {
            context.insert(item)
        }
        try context.save()
        try trimCache(in: context)
    }

    /// Confirms a cached trade is still live; removes it locally and returns
    /// `true` if the server reports it retracted (404 on `GET /trade/:id`).
    /// Best-effort: network errors leave the cached copy untouched rather
    /// than risk dropping a still-valid row on a flaky connection.
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

    private static func chamberFilterKey(for chambers: Set<ChamberFilter>) -> String {
        let normalized = chambers.isEmpty ? initialChambers : chambers
        return normalized.map(\.rawValue).sorted().joined(separator: ",")
    }

    /// The `chamber=` query value for a selection, or `nil` to omit the
    /// parameter entirely when the selection matches the backend's true
    /// default. Omitting (rather than spelling out "house,senate") matters:
    /// the backend's absent-chamber default also keeps rows whose chamber
    /// could not be resolved, while an explicit `chamber=house,senate` would
    /// narrow to just those two and drop unresolved rows. See
    /// `app/src/delivery/rows.ts` `buildTxFilters`.
    private static func chamberQueryValue(for chambers: Set<ChamberFilter>) -> String? {
        let normalized = chambers.isEmpty ? initialChambers : chambers
        let backendDefault: Set<ChamberFilter> = [.house, .senate]
        if normalized == backendDefault { return nil }
        return normalized.map(\.rawValue).sorted().joined(separator: ",")
    }

    private func fetchMaxLocalCursor() -> Int? {
        guard let context = modelContext else { return nil }
        var descriptor = FetchDescriptor<ClientTrade>()
        descriptor.sortBy = [SortDescriptor(\.cursor, order: .reverse)]
        descriptor.fetchLimit = 1
        do {
            let results = try context.fetch(descriptor)
            return results.first?.cursor
        } catch {
            return nil
        }
    }

    private func trimCache(in context: ModelContext) throws {
        var descriptor = FetchDescriptor<ClientTrade>(sortBy: [SortDescriptor(\.cursor, order: .reverse)])
        descriptor.fetchOffset = Self.cacheLimit
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

    func createDelivery(mode: DeliveryMode, webhookURL: String) async {
        let normalizedURL = webhookURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let mutation = PendingDeliveryMutation(
            mode: mode,
            webhookURL: normalizedURL,
            tickers: watchlist,
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
                    tickers: watchlist,
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
                    tickers: watchlist,
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

    /// Drops the one-time delivery secret from app state. Called when the
    /// credential sheet disappears so the value doesn't linger in memory any
    /// longer than the user is actively viewing it. CT-AUD-023.
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
            watchlistNotice = "Session token saved to Keychain."
            Task {
                await refresh()
            }
            return true
        } catch {
            watchlistNotice = "Failed to save token: \(error.localizedDescription)"
            return false
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
            watchlistNotice = "Signed out and revoked the server session."
            await refresh()
        } catch {
            watchlistNotice = "Sign-out failed; the token remains in Keychain so you can retry revocation: \(error.localizedDescription)"
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
    let tickers: [String]
    let idempotencyKey: String

    func matches(_ other: PendingDeliveryMutation) -> Bool {
        mode == other.mode && webhookURL == other.webhookURL && tickers == other.tickers
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
