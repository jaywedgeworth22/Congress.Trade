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
                        // The nav bar carries the entity class ("Ticker"), so
                        // the symbol has to live here while the hero is empty.
                        ProgressView("Loading \(ticker.uppercased())…")
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
                                Text(heroTitle)
                                    .font(.title2.weight(.bold))
                                    .multilineTextAlignment(.center)

                                if !headerMetaLine.isEmpty {
                                    Text(headerMetaLine)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .multilineTextAlignment(.center)
                                }
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
                                // Providers routinely file a sub-industry as the
                                // sector, so KO came back "Beverages" under BOTH
                                // labels. One value never earns two rows.
                                if let sector = sectorValue {
                                    DetailRow("Sector", sector)
                                }
                                if let industry = distinctIndustryValue {
                                    DetailRow("Industry", industry)
                                }
                                if let cap = marketCapLine {
                                    DetailRow("Market Cap", cap)
                                }
                                if let exchange = asset?.exchangeShort, !exchange.isEmpty {
                                    DetailRow("Exchange", exchange)
                                }
                                if let assetClass = asset?.assetClass, !assetClass.isEmpty {
                                    DetailRow("Asset Class", assetClass.assetClassLabel)
                                }
                                if let currency = asset?.currency, !currency.isEmpty {
                                    DetailRow("Currency", currency.uppercased())
                                }
                            }
                        }

                        // Summary
                        if let summary {
                            DetailSection("Trading Summary") {
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
                                // "Exchanges" read as NYSE/Nasdaq next to the
                                // Exchange row two sections up; this is the
                                // count of exchange-type disclosures.
                                if let exchangeCount = summary.exchangeCount, exchangeCount > 0 {
                                    DetailRow("Exchange Trades", CompactFormat.count(exchangeCount))
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
            // Nav bar carries the entity CLASS, the hero carries the identity.
            // The bar used to read "KO" directly above a hero that already said
            // KO — owner: "the ticker appears twice ... across four lines".
            .navigationTitle("Ticker")
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

    /// Hero identity: the company when we know it, otherwise the symbol.
    private var heroTitle: String {
        let name = asset?.companyName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? ticker.uppercased() : name
    }

    /// Meta line under the hero. Every fact appears exactly once: the symbol is
    /// dropped when the hero already IS the symbol, and the industry is dropped
    /// when the provider filed the same string as the sector (KO shipped
    /// "KO · NYSE · Beverages · Beverages").
    private var headerMetaLine: String {
        let symbol = ticker.uppercased()
        return [
            heroTitle == symbol ? nil : symbol,
            asset?.exchangeShort,
            sectorValue,
            distinctIndustryValue
        ]
        .compactMap { $0 }
        .filter { !$0.isEmpty }
        .joined(separator: "  •  ")
    }

    private var sectorValue: String? {
        asset?.sector?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    /// Industry only when it says something the sector row does not.
    private var distinctIndustryValue: String? {
        guard let industry = asset?.industry?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty else { return nil }
        guard let sector = sectorValue else { return industry }
        return sector.caseInsensitiveCompare(industry) == .orderedSame ? nil : industry
    }

    /// One Market Cap row, not a bucket row plus a "Market Cap ($)" row: the
    /// dollar figure leads and the bucket qualifies it (`$268b  •  Mega Cap`).
    private var marketCapLine: String? {
        let bucket = asset?.marketCapBucket?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty?.capBucketLabel
        let dollars = (asset?.marketCap ?? 0) > 0 ? CompactFormat.usd(asset?.marketCap) : nil
        return [dollars, bucket].compactMap { $0 }.joined(separator: "  •  ").nilIfEmpty
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
            let response = try await fetchTicker()
            if Task.isCancelled { return }
            self.asset = response.asset
            self.summary = response.summary
            self.trades = response.items
        } catch is CancellationError {
            return
        } catch let error as APIError where error.isCancellation {
            return
        } catch {
            if Task.isCancelled { return }
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }

    private func fetchTicker() async throws -> ClientTickerResponse {
        do {
            return try await store.api.ticker(ticker)
        } catch let error as APIError where error.isRetryable {
            try await Task.sleep(for: .milliseconds(400))
            return try await store.api.ticker(ticker)
        }
    }
}

/// Storage enums are not labels. `securities_ref.asset_class` is written by the
/// enricher as `equity|etf|adr|fund` (`app/src/enrichment/fmp.ts`) and
/// `market_cap_bucket` as `mega`…`nano`; both were rendered raw or merely
/// `.capitalized`, so the sheet read "Asset Class: equity" / "Market Cap:
/// Mega". Wording matches the web board's `CAP_NAMES`
/// (`app/src/ui/dashboardHtml.ts`). Deliberately fileprivate: the shared
/// labeler lives in another lane's file.
private extension String {
    var assetClassLabel: String {
        switch trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "equity", "stock", "common stock": return "Stock"
        case "etf": return "ETF"
        case "adr": return "ADR"
        case "fund", "mutual fund": return "Fund"
        case "crypto": return "Crypto"
        default: return capitalized
        }
    }

    var capBucketLabel: String {
        switch trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "mega": return "Mega Cap"
        case "large": return "Large Cap"
        case "mid": return "Mid Cap"
        case "small": return "Small Cap"
        case "micro": return "Micro Cap"
        case "nano": return "Nano Cap"
        case "unknown", "": return "Unclassified"
        default: return capitalized
        }
    }

    var nilIfEmpty: String? { isEmpty ? nil : self }
}
