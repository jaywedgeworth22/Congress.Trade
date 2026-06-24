import SwiftUI

@main
struct CongressTradeApp: App {
    @StateObject private var store = CongressTradeStore(api: CongressTradeAPIClient())

    var body: some Scene {
        WindowGroup {
            PrototypeRootView()
                .environmentObject(store)
        }
    }
}

@MainActor
final class CongressTradeStore: ObservableObject {
    @Published var bootstrap: BootstrapResponse?
    @Published var feed: ClientFeedResponse?
    @Published var subscriptions: [Subscription] = []
    @Published var commands: [ClientCommand] = []
    @Published var selectedTrade: ClientTrade?
    @Published var watchlistText = "AAPL, MSFT, NVDA"
    @Published var webhookURL = ""
    @Published var deliveryMode: DeliveryMode = .sse
    @Published var searchText = ""
    @Published var isLoading = false
    @Published var message: String?
    @Published var lastCommand: ClientCommand?

    private let api: CongressTradeAPIClient

    init(api: CongressTradeAPIClient) {
        self.api = api
    }

    var signedIn: Bool {
        bootstrap?.auth.user != nil
    }

    var entitlementLabel: String {
        bootstrap?.auth.entitlement.premium == true ? "Premium" : "Free"
    }

    var tickerList: [String] {
        watchlistText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
            .filter { !$0.isEmpty }
    }

    var filteredTrades: [ClientTrade] {
        let items = feed?.items ?? []
        let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return items }
        return items.filter { trade in
            [
                trade.asset.ticker,
                trade.asset.name,
                trade.member.name,
                trade.member.state,
                trade.member.chamber
            ].contains { ($0 ?? "").lowercased().contains(needle) }
        }
    }

    func refresh() async {
        isLoading = true
        message = nil
        do {
            async let bootstrapTask = api.bootstrap()
            async let feedTask = api.feed(query: FeedQuery(limit: 50, order: "desc"))
            bootstrap = try await bootstrapTask
            feed = try await feedTask
            if signedIn {
                await refreshSignedInState()
            }
        } catch {
            message = error.localizedDescription
        }
        isLoading = false
    }

    func refreshSignedInState() async {
        do {
            async let subscriptionsTask = api.subscriptions()
            async let commandsTask = api.commands(limit: 12)
            subscriptions = try await subscriptionsTask.subscriptions
            commands = try await commandsTask.commands
        } catch {
            if signedIn {
                message = error.localizedDescription
            }
        }
    }

    func saveWatchlist() async {
        await runCommand {
            try await api.updatePreferences(tickers: tickerList)
        }
    }

    func createDelivery() async {
        await runCommand {
            switch deliveryMode {
            case .sse:
                return try await api.createSSESubscription(tickers: tickerList)
            case .webhook:
                return try await api.createWebhookSubscription(targetURL: webhookURL, tickers: tickerList)
            }
        }
    }

    func toggleSubscription(_ subscription: Subscription) async {
        await runCommand {
            try await api.updateSubscription(
                id: subscription.id,
                active: !subscription.active,
                targetURL: nil,
                tickers: tickerList
            )
        }
    }

    private func runCommand<ResultPayload: Decodable>(
        _ operation: () async throws -> ClientCommandResponse<ResultPayload>
    ) async {
        do {
            let response = try await operation()
            lastCommand = response.command
            message = response.replayed == true
                ? "Command replayed: \(response.command.status.rawValue.capitalized)"
                : "Command \(response.command.status.rawValue.capitalized)"
            await refreshSignedInState()
        } catch {
            message = error.localizedDescription
        }
    }
}

enum DeliveryMode: String, CaseIterable, Identifiable {
    case sse = "SSE"
    case webhook = "Webhook"

    var id: String { rawValue }
}

struct PrototypeRootView: View {
    @EnvironmentObject private var store: CongressTradeStore

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
            if store.feed == nil {
                await store.refresh()
            }
        }
    }
}

struct FeedDashboardView: View {
    @EnvironmentObject private var store: CongressTradeStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    HeaderSummary()

                    SearchField(text: $store.searchText)

                    if let message = store.message {
                        NoticeView(message: message)
                    }

                    LazyVStack(spacing: 10) {
                        ForEach(store.filteredTrades) { trade in
                            TradeCard(trade: trade)
                                .onTapGesture {
                                    store.selectedTrade = trade
                                }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle("Congress.Trade")
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
                if store.isLoading {
                    ProgressView()
                        .controlSize(.large)
                        .padding(20)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .sheet(item: $store.selectedTrade) { trade in
                TradeDetailView(trade: trade)
            }
        }
    }
}

struct HeaderSummary: View {
    @EnvironmentObject private var store: CongressTradeStore

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
                StatusPill(text: store.signedIn ? "Signed In" : "Guest", color: store.signedIn ? .green : .orange)
            }

            HStack(spacing: 8) {
                MetricTile(title: "Trades", value: "\(store.feed?.total ?? 0)")
                MetricTile(title: "Cursor", value: "\(store.feed?.cursor ?? 0)")
                MetricTile(title: "Plan", value: store.entitlementLabel)
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
            TextField("Search ticker, member, or state", text: $text)
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
                    Text(trade.member.name ?? "Unknown Member")
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
                        DetailRow("Member", trade.member.name ?? "Unknown")
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

                    if let sourceURL = trade.filing.sourceUrl, let url = URL(string: sourceURL) {
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

    var body: some View {
        NavigationStack {
            Form {
                Section("Saved Tickers") {
                    TextField("AAPL, MSFT, NVDA", text: $store.watchlistText, axis: .vertical)
                        .tickerAutocapitalized()
                        .autocorrectionDisabled()
                    Button {
                        Task { await store.saveWatchlist() }
                    } label: {
                        Label("Save Through Command Gateway", systemImage: "checkmark.circle")
                    }
                    .disabled(!store.signedIn)
                }

                Section("How It Works") {
                    Text("The iPhone app saves preferences on the backend. The phone never stores provider keys, admin tokens, crawler logic, or MCP orchestration.")
                        .foregroundStyle(.secondary)
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Watch")
        }
    }
}

struct DeliveryView: View {
    @EnvironmentObject private var store: CongressTradeStore

    var body: some View {
        NavigationStack {
            Form {
                Section("Create Delivery") {
                    Picker("Mode", selection: $store.deliveryMode) {
                        ForEach(DeliveryMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)

                    if store.deliveryMode == .webhook {
                        TextField("https://example.com/webhook", text: $store.webhookURL)
                            .urlKeyboard()
                            .neverAutocapitalized()
                            .autocorrectionDisabled()
                    }

                    Button {
                        Task { await store.createDelivery() }
                    } label: {
                        Label("Create Delivery", systemImage: "paperplane")
                    }
                    .disabled(!store.signedIn)
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

enum AppTheme {
    static let background = Color(red: 0.04, green: 0.07, blue: 0.13)
    static let panel = Color(red: 0.07, green: 0.12, blue: 0.21)
    static let panelElevated = Color(red: 0.09, green: 0.16, blue: 0.28)
    static let borderColor = Color(red: 0.15, green: 0.23, blue: 0.38)

    static var border: some View {
        RoundedRectangle(cornerRadius: 8)
            .stroke(borderColor, lineWidth: 1)
    }
}

extension Optional where Wrapped == String {
    var shortDate: String {
        guard let self, !self.isEmpty else { return "Unavailable" }
        return Self.format(self, style: .medium)
    }

    var longDate: String {
        guard let self, !self.isEmpty else { return "Unavailable" }
        return Self.format(self, style: .long)
    }

    private static func format(_ value: String, style: DateFormatter.Style) -> String {
        let raw = String(value.prefix(10))
        let input = DateFormatter()
        input.calendar = Calendar(identifier: .gregorian)
        input.locale = Locale(identifier: "en_US_POSIX")
        input.timeZone = TimeZone(secondsFromGMT: 0)
        input.dateFormat = "yyyy-MM-dd"
        guard let date = input.date(from: raw) else { return value }
        let output = DateFormatter()
        output.dateStyle = style
        output.timeStyle = .none
        output.timeZone = TimeZone(secondsFromGMT: 0)
        return output.string(from: date)
    }
}

extension ClientTrade {
    var amountLabel: String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.maximumFractionDigits = 0
        guard let min = transaction.amountMin else { return "Undisclosed" }
        let low = formatter.string(from: NSNumber(value: min)) ?? "$\(min)"
        guard let max = transaction.amountMax else { return "\(low)+" }
        let high = formatter.string(from: NSNumber(value: max)) ?? "$\(max)"
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
