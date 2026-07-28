import SwiftUI

/// Ticker profile backed by `GET /api/client/v1/ticker/:ticker`
/// (`app/src/client/routes.ts`): security-ref identity, aggregate summary,
/// and the recent trade page. Mirrors PoliticianDetailView.
struct TickerDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: CongressTradeStore

    let ticker: String

    @State private var isLoading = true
    @State private var asset: ClientTickerResponse.TickerAsset?
    @State private var summary: ClientTickerResponse.TickerSummary?
    @State private var trades: [ClientTrade] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if isLoading {
                        ProgressView("Loading Ticker...")
                            .padding(.top, 40)
                    } else if let error = error {
                        ContentUnavailableView("Error", systemImage: "exclamationmark.triangle", description: Text(error))
                    } else {
                        // Header
                        VStack(spacing: 12) {
                            AssetMark(symbol: ticker, isTicker: true)
                                .scaleEffect(1.3)
                                .padding(.bottom, 8)

                            VStack(spacing: 4) {
                                Text(asset?.companyName ?? ticker)
                                    .font(.title2.weight(.bold))
                                    .multilineTextAlignment(.center)

                                Text([ticker.uppercased(), asset?.exchangeShort, asset?.sector].compactMap { $0 }.joined(separator: " · "))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.top, 16)

                        // Summary
                        if let summary {
                            DetailSection("Congressional Trading Summary") {
                                HStack(spacing: 12) {
                                    MetricTile(title: "Trades", value: CompactFormat.count(summary.totalTrades))
                                    MetricTile(title: "Buys", value: CompactFormat.count(summary.buyCount))
                                    MetricTile(title: "Sells", value: CompactFormat.count(summary.sellCount))
                                }
                                HStack(spacing: 12) {
                                    MetricTile(title: "Members", value: CompactFormat.count(summary.memberCount))
                                    MetricTile(title: "Est. Volume", value: CompactFormat.usd(summary.estimatedVolumeUsd))
                                    MetricTile(title: "Net Flow", value: CompactFormat.usd(summary.estimatedNetFlowUsd))
                                }
                                DetailRow("First Trade", summary.firstTrade.shortDate)
                                DetailRow("Last Trade", summary.lastTrade.shortDate)
                            }
                        }

                        // Recent Trades
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Recent Trades")
                                .font(.headline)
                                .padding(.horizontal, 16)

                            LazyVStack(spacing: 12) {
                                ForEach(trades) { trade in
                                    NavigationLink {
                                        TradeDetailView(trade: trade)
                                    } label: {
                                        TradeCard(trade: trade)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 16)
                        }
                    }
                }
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle(ticker.uppercased())
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .task {
                await loadTicker()
            }
        }
    }

    private func loadTicker() async {
        isLoading = true
        error = nil
        do {
            let response = try await store.api.ticker(ticker)
            self.asset = response.asset
            self.summary = response.summary
            self.trades = response.items
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}
