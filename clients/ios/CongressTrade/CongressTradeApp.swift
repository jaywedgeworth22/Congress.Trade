import SwiftUI
import SwiftData

@main
struct CongressTradeApp: App {
    @StateObject private var store = CongressTradeStore(api: CongressTradeAPIClient())

    var body: some Scene {
        WindowGroup {
            PrototypeRootView()
                .environmentObject(store)
        }
        .modelContainer(for: ClientTrade.self)
    }
}
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

    var modelContext: ModelContext?

    private let api: CongressTradeAPIClient
    private var pendingWatchlistMutation: PendingWatchlistMutation?
    private var pendingDeliveryMutation: PendingDeliveryMutation?
    private var pendingSubscriptionMutations: [String: PendingSubscriptionMutation] = [:]

    private static let cacheLimit = 500

    init(api: CongressTradeAPIClient) {
        self.api = api
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

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        feedNotice = nil
        do {
            let maxCursor = fetchMaxLocalCursor()
            async let bootstrapTask = api.bootstrap()
            async let feedTask = api.feed(query: FeedQuery(limit: 50, since: maxCursor, order: "desc"))

            bootstrap = try await bootstrapTask
            let response = try await feedTask

            if let context = modelContext {
                for item in response.items {
                    context.insert(item)
                }
                try context.save()
                try trimCache(in: context)
            }

            feed = response
            lastSuccessfulRefresh = Date()
            isOffline = false
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
        guard !tickers.isEmpty else {
            watchlistNotice = "Enter at least one ticker."
            return
        }
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

struct PrototypeRootView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.modelContext) private var modelContext

    var body: some View {
        TabView {
            FeedDashboardView()
                .tabItem {
                    Label("Feed", systemImage: "list.bullet.rectangle")
                }

            WatchlistView()
                .tabItem {
                    Label("Watch", systemImage: "line.3.horizontal.decrease.circle")
                }

            DeliveryView()
                .tabItem {
                    Label("Delivery", systemImage: "antenna.radiowaves.left.and.right")
                }

            CommandStatusView()
                .tabItem {
                    Label("Status", systemImage: "checkmark.seal")
                }
        }
        .tint(.blue)
        .task {
            store.modelContext = modelContext
            if store.feed == nil {
                await store.refresh()
            }
        }
    }
}

struct FeedDashboardView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Query(sort: \ClientTrade.cursor, order: .reverse) private var cachedTrades: [ClientTrade]
    @State private var searchText = ""
    @State private var appliedSearch = ""
    @State private var searchTask: Task<Void, Never>?
    @State private var selectedTrade: ClientTrade?

    var filteredTrades: [ClientTrade] {
        let needle = appliedSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return cachedTrades }
        return cachedTrades.filter { TradeSearch.matches($0, normalizedNeedle: needle) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    HeaderSummary(
                        tradeCount: cachedTrades.count,
                        cursor: cachedTrades.first?.cursor ?? 0,
                        signedIn: store.signedIn,
                        entitlementLabel: store.entitlementLabel
                    )

                    SearchField(text: $searchText)

                    FeedFreshnessView(
                        isOffline: store.isOffline,
                        lastRefresh: store.lastSuccessfulRefresh,
                        notice: store.feedNotice,
                        onRetry: { Task { await store.refresh() } }
                    )

                    if filteredTrades.isEmpty && !store.isRefreshing {
                        ContentUnavailableView {
                            Label(
                                appliedSearch.isEmpty ? "No Saved Trades" : "No Matching Trades",
                                systemImage: "tray"
                            )
                        } description: {
                            Text(appliedSearch.isEmpty ? "Refresh to load the latest disclosures." : "Try another ticker, politician, or state.")
                        } actions: {
                            Button("Retry") { Task { await store.refresh() } }
                        }
                    }

                    LazyVStack(spacing: 10) {
                        ForEach(filteredTrades) { trade in
                            Button {
                                selectedTrade = trade
                            } label: {
                                TradeCard(trade: trade)
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Opens trade details")
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle("Congress.Trade")
            .refreshable { await store.refresh() }
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button {
                        Task { await store.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh")
                }
            }
            .overlay {
                if store.isRefreshing {
                    ProgressView()
                        .controlSize(.large)
                        .padding(20)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .sheet(item: $selectedTrade) { trade in
                TradeDetailView(trade: trade)
            }
            .onChange(of: searchText) { _, newValue in
                searchTask?.cancel()
                searchTask = Task {
                    try? await Task.sleep(for: .milliseconds(180))
                    guard !Task.isCancelled else { return }
                    appliedSearch = newValue
                }
            }
            .onDisappear { searchTask?.cancel() }
        }
    }
}

struct HeaderSummary: View {
    let tradeCount: Int
    let cursor: Int
    let signedIn: Bool
    let entitlementLabel: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Live Control Surface")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text("Fast congressional trade monitoring")
                        .font(.title3.weight(.semibold))
                }
                Spacer()
                StatusPill(text: signedIn ? "Signed In" : "Guest", color: signedIn ? .green : .orange)
            }

            HStack(spacing: 8) {
                MetricTile(title: "Trades", value: "\(tradeCount)")
                MetricTile(title: "Cursor", value: "\(cursor)")
                MetricTile(title: "Plan", value: entitlementLabel)
            }
        }
        .padding(14)
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 8))
        .overlay(AppTheme.border)
    }
}

struct SearchField: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search ticker, politician, or state", text: $text)
                .neverAutocapitalized()
                .autocorrectionDisabled()
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Clear Search")
            }
        }
        .padding(12)
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 8))
        .overlay(AppTheme.border)
    }
}

struct TradeCard: View {
    let trade: ClientTrade

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                AssetMark(symbol: trade.asset.ticker ?? trade.asset.type ?? "A")
                VStack(alignment: .leading, spacing: 3) {
                    Text(assetTitle)
                        .font(.headline)
                        .lineLimit(1)
                    Text(trade.asset.name)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                StatusPill(text: trade.transaction.type.label, color: trade.transaction.type.tint)
            }

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(trade.member.name ?? "Unknown Politician")
                        .font(.subheadline.weight(.semibold))
                    Text(memberMeta)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(trade.amountLabel)
                        .font(.subheadline.weight(.semibold))
                    Text(trade.source == .primary ? "Live Read" : "Historical")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 8) {
                DateChip(title: "Traded", value: trade.transaction.date.shortDate)
                DateChip(title: "Filed", value: trade.filing.filedDate.shortDate)
                DateChip(title: "Seen", value: trade.filing.firstSeenAt.shortDate)
            }
        }
        .padding(14)
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 8))
        .overlay(AppTheme.border)
    }

    private var assetTitle: String {
        trade.asset.ticker ?? trade.asset.type ?? "Asset"
    }

    private var memberMeta: String {
        [trade.member.chamber?.capitalized, trade.member.state, trade.member.party]
            .compactMap { value in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .joined(separator: " · ")
    }
}

struct TradeDetailView: View {
    let trade: ClientTrade
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        AssetMark(symbol: trade.asset.ticker ?? trade.asset.type ?? "A")
                        VStack(alignment: .leading, spacing: 4) {
                            Text(trade.asset.ticker ?? "Asset")
                                .font(.title2.weight(.semibold))
                            Text(trade.asset.name)
                                .foregroundStyle(.secondary)
                        }
                    }

                    DetailSection("Trade") {
                        DetailRow("Politician", trade.member.name ?? "Unknown")
                        DetailRow("Action", trade.transaction.type.label)
                        DetailRow("Amount", trade.amountLabel)
                        DetailRow("Owner", trade.transaction.owner?.capitalized ?? "Unavailable")
                        DetailRow("Confidence", "\(Int((trade.confidence * 100).rounded()))%")
                    }

                    DetailSection("Dates") {
                        DetailRow("Traded", trade.transaction.date.longDate)
                        DetailRow("Filed", trade.filing.filedDate.longDate)
                        DetailRow("Seen", trade.filing.firstSeenAt.longDate)
                    }

                    DetailSection("Company") {
                        DetailRow("Sector", trade.asset.sector ?? "Not Enriched Yet")
                        DetailRow("Market Cap", trade.asset.marketCapBucket?.capitalized ?? "Not Enriched Yet")
                    }

                    if let sourceURL = trade.filing.sourceUrl,
                       let url = URL(string: sourceURL),
                       url.scheme == "https" || url.scheme == "http" {
                        Button {
                            openURL(url)
                        } label: {
                            Label("View Source Filing", systemImage: "doc.text.magnifyingglass")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
                .padding(16)
            }
            .background(AppTheme.background)
            .navigationTitle("Trade Detail")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct WatchlistView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @State private var sessionTokenInput = ""
    @State private var watchlistText = ""
    @State private var hasInitializedWatchlist = false
    @State private var lastLoadedWatchlistText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Keychain Authentication") {
                    SecureField("Session Token", text: $sessionTokenInput)
                        .privacySensitive()
                    Button {
                        if store.saveSessionToken(sessionTokenInput) {
                            sessionTokenInput = ""
                        }
                    } label: {
                        Label("Save Session Token", systemImage: "key.fill")
                    }
                    .disabled(sessionTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if store.hasStoredSessionToken {
                        Button(role: .destructive) {
                            Task { await store.signOut() }
                        } label: {
                            Label("Sign Out and Revoke Session", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                        .disabled(store.isLoggingOut)
                    }
                }

                Section("Saved Tickers") {
                    TextField("AAPL, MSFT, NVDA", text: $watchlistText, axis: .vertical)
                        .tickerAutocapitalized()
                        .autocorrectionDisabled()
                    Button {
                        Task { await store.saveWatchlist(watchlistText) }
                    } label: {
                        if store.isSavingWatchlist {
                            ProgressView()
                        } else {
                            Label("Save Watchlist", systemImage: "checkmark.circle")
                        }
                    }
                    .disabled(!store.signedIn || store.isSavingWatchlist)
                    if let notice = store.watchlistNotice {
                        NoticeView(message: notice)
                    }
                }

                Section("How It Works") {
                    Text("The iPhone app saves preferences on the backend. The phone never stores provider keys, admin tokens, crawler logic, or MCP orchestration.")
                        .foregroundStyle(.secondary)
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Watch")
            .onAppear { initializeWatchlistIfNeeded() }
            .onChange(of: store.watchlist) { _, _ in initializeWatchlistIfNeeded(force: true) }
        }
    }

    private func initializeWatchlistIfNeeded(force: Bool = false) {
        let serverText = store.watchlist.joined(separator: ", ")
        guard force || !hasInitializedWatchlist else { return }
        if !hasInitializedWatchlist || watchlistText == lastLoadedWatchlistText {
            watchlistText = serverText
        }
        lastLoadedWatchlistText = serverText
        hasInitializedWatchlist = true
    }
}

struct DeliveryView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @State private var deliveryMode: DeliveryMode = .sse
    @State private var webhookURL = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Create Delivery") {
                    Picker("Mode", selection: $deliveryMode) {
                        ForEach(DeliveryMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)

                    if deliveryMode == .webhook {
                        TextField("https://example.com/webhook", text: $webhookURL)
                            .urlKeyboard()
                            .neverAutocapitalized()
                            .autocorrectionDisabled()
                    }

                    Button {
                        Task { await store.createDelivery(mode: deliveryMode, webhookURL: webhookURL) }
                    } label: {
                        if store.isCreatingDelivery {
                            ProgressView()
                        } else {
                            Label("Create Delivery", systemImage: "paperplane")
                        }
                    }
                    .disabled(!store.signedIn || store.isCreatingDelivery)
                    if let notice = store.deliveryNotice {
                        NoticeView(message: notice)
                    }
                }

                Section("Existing") {
                    if store.subscriptions.isEmpty {
                        Text(store.signedIn ? "No delivery subscriptions yet." : "Sign in to manage delivery subscriptions.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(store.subscriptions) { subscription in
                            SubscriptionRow(subscription: subscription) {
                                Task { await store.toggleSubscription(subscription) }
                            }
                            .disabled(store.subscriptionIDsInFlight.contains(subscription.id))
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Delivery")
            .toolbar {
                Button {
                    Task { await store.refreshSignedInState() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh deliveries")
            }
            .sheet(item: $store.pendingDeliveryCredential) { credential in
                DeliveryCredentialView(credential: credential)
            }
        }
    }
}

struct CommandStatusView: View {
    @EnvironmentObject private var store: CongressTradeStore

    var body: some View {
        NavigationStack {
            List {
                if let command = store.lastCommand {
                    Section("Latest") {
                        CommandRow(command: command)
                    }
                }

                Section("Recent Commands") {
                    if store.commands.isEmpty {
                        Text(store.signedIn ? "No commands yet." : "Sign in to view command status.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(store.commands) { command in
                            CommandRow(command: command)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Status")
            .toolbar {
                Button {
                    Task { await store.refreshSignedInState() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh command status")
            }
            .safeAreaInset(edge: .bottom) {
                if let notice = store.commandNotice {
                    NoticeView(message: notice)
                        .padding(.horizontal)
                        .padding(.bottom, 8)
                }
            }
        }
    }
}

struct SubscriptionRow: View {
    let subscription: Subscription
    let onToggle: () -> Void

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(subscription.delivery.uppercased())
                    .font(.headline)
                Text(subscription.targetUrl ?? subscription.streamUrl ?? "SSE stream")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text("Cursor \(subscription.cursor)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(subscription.active ? "Pause" : "Resume", action: onToggle)
                .buttonStyle(.bordered)
        }
    }
}

struct CommandRow: View {
    let command: ClientCommand

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(command.type.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.headline)
                Spacer()
                StatusPill(text: command.status.rawValue.capitalized, color: command.status.tint)
            }
            Text(command.id)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            if let error = command.error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.vertical, 4)
    }
}

struct MetricTile: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(AppTheme.panelElevated, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct StatusPill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
    }
}

struct AssetMark: View {
    let symbol: String

    var body: some View {
        Text(String(symbol.prefix(4)).uppercased())
            .font(.caption.weight(.bold).monospaced())
            .frame(width: 44, height: 44)
            .foregroundStyle(.white)
            .background(
                LinearGradient(colors: [.blue, .teal], startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: 8)
            )
    }
}

struct DateChip: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(AppTheme.panelElevated, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct DetailSection<Content: View>: View {
    let title: String
    let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            content
        }
        .padding(14)
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 8))
        .overlay(AppTheme.border)
    }
}

struct DetailRow: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer(minLength: 18)
            Text(value)
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
    }
}

struct NoticeView: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 8))
            .overlay(AppTheme.border)
    }
}

struct FeedFreshnessView: View {
    let isOffline: Bool
    let lastRefresh: Date?
    let notice: String?
    let onRetry: () -> Void

    var body: some View {
        if isOffline || notice != nil || lastRefresh != nil {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: isOffline ? "wifi.slash" : "clock.arrow.circlepath")
                    .foregroundStyle(isOffline ? .orange : .secondary)
                VStack(alignment: .leading, spacing: 3) {
                    if let notice {
                        Text(notice)
                            .font(.footnote)
                    }
                    if let lastRefresh {
                        Text("Updated \(lastRefresh.formatted(.relative(presentation: .named)))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if notice != nil {
                    Button("Retry", action: onRetry)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 8))
            .overlay(AppTheme.border)
        }
    }
}

struct DeliveryCredentialView: View {
    let credential: DeliveryCredential
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Shown Once", systemImage: "exclamationmark.shield.fill")
                        .foregroundStyle(.orange)
                    Text("Save this credential now. Congress.Trade does not return the secret in later subscription lists.")
                        .foregroundStyle(.secondary)
                }
                if let streamURL = credential.streamURL {
                    Section("Stream URL") {
                        Text(streamURL)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                            .privacySensitive()
                    }
                }
                if let secret = credential.secret {
                    Section("Subscription Secret") {
                        Text(secret)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                            .privacySensitive()
                    }
                }
                Section {
                    ShareLink(item: credential.shareText) {
                        Label("Share Securely", systemImage: "square.and.arrow.up")
                    }
                    .disabled(credential.shareText.isEmpty)
                }
            }
            .navigationTitle("Delivery Credential")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

enum AppTheme {
    static let background = Color(uiColor: .systemGroupedBackground)
    static let panel = Color(uiColor: .secondarySystemGroupedBackground)
    static let panelElevated = Color(uiColor: .tertiarySystemGroupedBackground)
    static let borderColor = Color(uiColor: .separator)

    static var border: some View {
        RoundedRectangle(cornerRadius: 8)
            .stroke(borderColor, lineWidth: 1)
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

@MainActor
private enum DisplayFormatters {
    static let inputDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static let shortDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    static let longDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .long
        formatter.timeStyle = .none
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    static let currency: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.maximumFractionDigits = 0
        return formatter
    }()
}

@MainActor
extension Optional where Wrapped == String {
    var shortDate: String {
        guard let self, !self.isEmpty else { return "Unavailable" }
        return Self.format(self, using: DisplayFormatters.shortDate)
    }

    var longDate: String {
        guard let self, !self.isEmpty else { return "Unavailable" }
        return Self.format(self, using: DisplayFormatters.longDate)
    }

    private static func format(_ value: String, using output: DateFormatter) -> String {
        let raw = String(value.prefix(10))
        guard let date = DisplayFormatters.inputDate.date(from: raw) else { return value }
        return output.string(from: date)
    }
}

@MainActor
extension ClientTrade {
    var amountLabel: String {
        guard let min = transaction.amountMin else { return "Undisclosed" }
        let low = DisplayFormatters.currency.string(from: NSNumber(value: min)) ?? "$\(min)"
        guard let max = transaction.amountMax else { return "\(low)+" }
        let high = DisplayFormatters.currency.string(from: NSNumber(value: max)) ?? "$\(max)"
        return "\(low) - \(high)"
    }
}

extension String {
    var label: String {
        switch self {
        case "S": return "Sale"
        case "P": return "Purchase"
        case "E": return "Exchange"
        default: return self
        }
    }

    var tint: Color {
        switch self {
        case "S": return .red
        case "P": return .green
        default: return .blue
        }
    }
}

extension ClientCommand.Status {
    var tint: Color {
        switch self {
        case .queued: return .orange
        case .running: return .blue
        case .succeeded: return .green
        case .failed: return .red
        case .canceled: return .secondary
        }
    }
}

enum AppToolbarPlacement {
    static var trailing: ToolbarItemPlacement {
        #if os(iOS)
        return .topBarTrailing
        #else
        return .automatic
        #endif
    }
}

extension View {
    @ViewBuilder
    func neverAutocapitalized() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    @ViewBuilder
    func tickerAutocapitalized() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.characters)
        #else
        self
        #endif
    }

    @ViewBuilder
    func urlKeyboard() -> some View {
        #if os(iOS)
        self.keyboardType(.URL)
        #else
        self
        #endif
    }

    @ViewBuilder
    func inlineNavigationTitle() -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
}
