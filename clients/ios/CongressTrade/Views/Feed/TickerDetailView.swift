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

                                Text(headerMetaLine)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                            }

                            if let price = asset?.currentPrice {
                                Text(String(format: "$%.2f", price))
                                    .font(.title3.weight(.semibold))
                                    .foregroundStyle(.primary)
                            }
                        }
                        .padding(.top, 16)

                        // Identity / enrichment (when present in model)
                        if assetHasIdentityRows {
                            DetailSection("Security") {
                                if let industry = asset?.industry, !industry.isEmpty {
                                    DetailRow("Industry", industry)
                                }
                                if let sector = asset?.sector, !sector.isEmpty {
                                    DetailRow("Sector", sector)
                                }
                                if let bucket = asset?.marketCapBucket, !bucket.isEmpty {
                                    DetailRow("Market Cap", bucket.capitalized)
                                }
                                if let marketCap = asset?.marketCap, marketCap > 0 {
                                    DetailRow("Market Cap ($)", CompactFormat.usd(marketCap))
                                }
                                if let exchange = asset?.exchangeShort, !exchange.isEmpty {
                                    DetailRow("Exchange", exchange)
                                }
                                if let assetClass = asset?.assetClass, !assetClass.isEmpty {
                                    DetailRow("Asset Class", assetClass)
                                }
                                if let currency = asset?.currency, !currency.isEmpty {
                                    DetailRow("Currency", currency)
                                }
                            }
                        }

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
                                if let exchangeCount = summary.exchangeCount, exchangeCount > 0 {
                                    DetailRow("Exchanges", CompactFormat.count(exchangeCount))
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
                    if let shareURL = store.api.shareURL(
                        queryItem: URLQueryItem(name: "ticker", value: ticker.uppercased())
                    ) {
                        ShareLink(item: shareURL) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("Share ticker")
                    }
                }
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

    private var headerMetaLine: String {
        [
            ticker.uppercased(),
            asset?.exchangeShort,
            asset?.sector,
            asset?.industry
        ]
        .compactMap { $0 }
        .filter { !$0.isEmpty }
        .joined(separator: " · ")
    }

    private var assetHasIdentityRows: Bool {
        guard let asset else { return false }
        return [
            asset.industry,
            asset.sector,
            asset.marketCapBucket,
            asset.exchangeShort,
            asset.assetClass,
            asset.currency
        ].contains(where: { ($0 ?? "").isEmpty == false })
            || (asset.marketCap ?? 0) > 0
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
