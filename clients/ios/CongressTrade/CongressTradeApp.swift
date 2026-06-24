import SwiftUI

@main
struct CongressTradeApp: App {
    @StateObject private var model = FeedModel(
        api: CongressTradeAPI(tokenStore: KeychainTokenStore())
    )

    var body: some Scene {
        WindowGroup {
            FeedView()
                .environmentObject(model)
        }
    }
}

@MainActor
final class FeedModel: ObservableObject {
    @Published var bootstrap: BootstrapResponse?
    @Published var feed: ClientFeedResponse?
    @Published var error: String?
    @Published var isLoading = false

    private let api: CongressTradeAPI

    init(api: CongressTradeAPI) {
        self.api = api
    }

    func refresh() async {
        isLoading = true
        error = nil
        do {
            async let boot = api.bootstrap()
            async let rows = api.feed(limit: 50)
            bootstrap = try await boot
            feed = try await rows
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func createSSE(tickers: [String]) async {
        do {
            _ = try await api.createSSESubscription(tickers: tickers)
            await refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct FeedView: View {
    @EnvironmentObject private var model: FeedModel
    @State private var tickers = "AAPL, MSFT, NVDA"

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        metric("Trades", "\(model.feed?.total ?? 0)")
                        metric("Cursor", "\(model.feed?.cursor ?? 0)")
                        metric("Plan", model.bootstrap?.auth.entitlement.premium == true ? "Premium" : "Free")
                    }
                }

                if let error = model.error {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }

                Section("Delivery") {
                    TextField("Tickers", text: $tickers)
                    Button("Create SSE Subscription") {
                        Task {
                            await model.createSSE(tickers: tickers.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) })
                        }
                    }
                }

                Section("Feed") {
                    ForEach(model.feed?.items ?? []) { trade in
                        TradeRow(trade: trade)
                    }
                }
            }
            .navigationTitle("Congress.Trade")
            .toolbar {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .task {
                if model.feed == nil {
                    await model.refresh()
                }
            }
            .overlay {
                if model.isLoading {
                    ProgressView()
                }
            }
        }
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.headline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct TradeRow: View {
    let trade: ClientTrade

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading) {
                    Text(trade.asset.ticker ?? "Asset")
                        .font(.headline.monospaced())
                    Text(trade.asset.name)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(label(for: trade.transaction.type))
                    .font(.caption.bold())
                    .foregroundStyle(trade.transaction.type == "S" ? .red : .green)
            }
            Text(trade.member.name ?? "Unknown Member")
                .font(.subheadline.weight(.semibold))
            HStack {
                Text(trade.transaction.date ?? "No Trade Date")
                Spacer()
                Text(trade.source == .primary ? "Live" : "Historical")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }

    private func label(for type: String) -> String {
        switch type {
        case "S": return "Sale"
        case "P": return "Purchase"
        default: return "Exchange"
        }
    }
}
