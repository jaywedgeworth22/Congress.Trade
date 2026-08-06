import SwiftUI

struct TradeDetailView: View {
    let trade: ClientTrade
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var didCheckRetraction = false
    @State private var performance: TradePerformanceResponse?
    @State private var performanceLoaded = false
    @State private var performanceFailed = false
    @State private var performanceTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Hero Header — company name + chevron link like politician
                    VStack(alignment: .center, spacing: 12) {
                        AssetMark(
                            symbol: trade.asset.displayName,
                            isTicker: trade.asset.ticker != nil && !(trade.asset.ticker?.isEmpty ?? true)
                        )
                        .scaleEffect(1.3)
                        .padding(.bottom, 8)

                        companyTitle

                        StatusPill(
                            text: trade.transaction.type.label,
                            color: trade.transaction.type.tint,
                            icon: (trade.transaction.type == "B" || trade.transaction.type == "P")
                                ? "arrow.down.right.circle.fill"
                                : (trade.transaction.type == "S"
                                    ? "arrow.up.right.circle.fill"
                                    : "arrow.left.and.right.circle.fill")
                        )
                        .padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 32)
                    .background(
                        LinearGradient(
                            colors: [chamberGradient.opacity(0.2), AppTheme.background],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )

                    VStack(spacing: 16) {
                        DetailSection("Trade Summary") {
                            if let memberId = trade.member.id {
                                NavigationLink(
                                    destination: PoliticianDetailView(
                                        memberId: memberId,
                                        memberName: trade.member.name ?? "Unknown"
                                    )
                                ) {
                                    HStack {
                                        Text("Politician")
                                            .foregroundStyle(.secondary)
                                        Spacer()
                                        Text(trade.member.party?.partyEmoji ?? "")
                                        Text(trade.member.name ?? "Unknown")
                                            .fontWeight(.bold)
                                        Image(systemName: "chevron.right")
                                            .font(.caption.weight(.bold))
                                            .foregroundStyle(.tertiary)
                                            .padding(.leading, 2)
                                    }
                                    .font(.subheadline)
                                }
                                .buttonStyle(.plain)
                            } else {
                                HStack {
                                    Text("Politician")
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                    Text(trade.member.party?.partyEmoji ?? "")
                                    Text(trade.member.name ?? "Unknown")
                                        .fontWeight(.bold)
                                }
                                .font(.subheadline)
                            }

                            DetailRow("Amount", trade.amountLabel)
                            DetailRow("Owner", trade.transaction.owner?.capitalized ?? "Unavailable")
                            DetailRow("Confidence", "\(Int(((trade.confidence ?? 1.0) * 100).rounded()))%")
                        }

                        performanceSection

                        // TODO(ios): dual-axis chart S&P vs stock since filing when
                        // a lightweight Charts series endpoint is available.

                        DetailSection("Timeline") {
                            DetailRow("Traded", trade.transaction.date.longDate)
                            DetailRow("Filed", trade.filing.filedDate.longDate)
                            DetailRow("Discovered", trade.filing.firstSeenAt.longDate)
                        }

                        DetailSection("Company Info") {
                            if let ticker = trade.asset.ticker, !ticker.isEmpty {
                                NavigationLink(destination: TickerDetailView(ticker: ticker)) {
                                    HStack {
                                        Text("Asset")
                                            .foregroundStyle(.secondary)
                                        Spacer()
                                        Text(trade.asset.displayName)
                                            .fontWeight(.bold)
                                        Image(systemName: "chevron.right")
                                            .font(.caption.weight(.bold))
                                            .foregroundStyle(.tertiary)
                                            .padding(.leading, 2)
                                    }
                                    .font(.subheadline)
                                }
                                .buttonStyle(.plain)
                            } else {
                                DetailRow("Asset", trade.asset.displayName)
                            }
                            DetailRow("Sector", trade.asset.sector ?? "Not Enriched Yet")
                            DetailRow("Market Cap", trade.asset.marketCapBucket?.capitalized ?? "Not Enriched Yet")
                        }

                        filingButtons
                    }
                    .padding(.horizontal, 16)
                }
            }
            .background(AppTheme.background)
            .navigationTitle("Trade Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let shareURL = store.api.shareURL(queryItem: URLQueryItem(name: "trade", value: trade.id)) {
                    ToolbarItem(placement: AppToolbarPlacement.trailing) {
                        ShareLink(item: shareURL) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("Share trade")
                    }
                }
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            // The feed never re-announces a row it already served once it's
            // retracted (see app/docs/client-mobile-api.md); reconcile this
            // cached copy against `GET /trade/:id` on open so a stale,
            // retracted disclosure doesn't linger silently. CT-AUD-009.
            guard !didCheckRetraction else { return }
            didCheckRetraction = true
            if await store.reconcileIfDeprecated(trade) {
                dismiss()
            }
        }
        .task(id: trade.id) {
            await loadPerformance()
        }
        .onDisappear {
            performanceTask?.cancel()
        }
    }

    /// Company name at top with ">" link like politician when a ticker exists.
    @ViewBuilder
    private var companyTitle: some View {
        let display = trade.asset.displayName
        let companyName: String? = {
            guard let name = trade.asset.name, !name.isEmpty, name != trade.asset.ticker else { return nil }
            return name
        }()

        if let ticker = trade.asset.ticker, !ticker.isEmpty {
            NavigationLink(destination: TickerDetailView(ticker: ticker)) {
                HStack(spacing: 6) {
                    Text(display)
                        .font(.largeTitle.weight(.heavy))
                        .multilineTextAlignment(.center)
                    Image(systemName: "chevron.right")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("View \(display) trades")

            if let companyName {
                Text(companyName)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        } else {
            Text(display)
                .font(.largeTitle.weight(.heavy))
                .multilineTextAlignment(.center)
            if let companyName {
                Text(companyName)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    /// PDF + source filing side-by-side (~half width), liquid-glass / light grey,
    /// no "View" word in the labels.
    @ViewBuilder
    private var filingButtons: some View {
        let pdfURL: URL? = {
            guard let docId = trade.docId, !docId.isEmpty else { return nil }
            return store.api.documentPDFURL(docId: docId)
        }()
        let sourceURL: URL? = {
            guard let raw = trade.filing.sourceUrl,
                  let url = URL(string: raw),
                  url.scheme == "https" || url.scheme == "http" else { return nil }
            return url
        }()

        if pdfURL != nil || sourceURL != nil {
            HStack(spacing: 10) {
                if let pdfURL {
                    Button {
                        openURL(pdfURL)
                    } label: {
                        Label("Filing PDF", systemImage: "doc.richtext")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.bordered)
                    .tint(chamberGradient.opacity(0.85))
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }

                if let sourceURL {
                    Button {
                        openURL(sourceURL)
                    } label: {
                        Label("Source Filing", systemImage: "doc.text.magnifyingglass")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.bordered)
                    .tint(chamberGradient.opacity(0.85))
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }
            }
            .padding(.top, 8)
        }
    }

    @ViewBuilder
    private var performanceSection: some View {
        DetailSection("Performance vs S&P 500") {
            if !performanceLoaded {
                HStack {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading returns…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if let perf = performance, perf.available, let leg = perf.tradeLeg {
                let isSell = (perf.txType ?? trade.transaction.type) == "S"
                let sinceLabel = isSell ? "Since sold" : "Since traded"
                let politician = trade.member.name ?? "Politician"
                let asset = perf.ticker ?? trade.asset.displayName

                Text("\(politician) · \(asset)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                HStack(spacing: 12) {
                    MetricTile(
                        title: sinceLabel,
                        value: Self.formatSignedPct(leg.assetReturn)
                    )
                    MetricTile(
                        title: "S&P 500",
                        value: Self.formatSignedPct(leg.spxReturn)
                    )
                    MetricTile(
                        title: "Excess",
                        value: Self.formatSignedPct(leg.excessReturn)
                    )
                }

                if let filing = perf.filingDatePerformance,
                   filing.assetReturn != nil || filing.excessReturn != nil {
                    let filingLabel = isSell ? "Since reported" : "Since filing"
                    VStack(alignment: .leading, spacing: 8) {
                        Text(filingLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        HStack(spacing: 12) {
                            MetricTile(
                                title: "Return",
                                value: Self.formatSignedPct(filing.assetReturn)
                            )
                            MetricTile(
                                title: "S&P 500",
                                value: Self.formatSignedPct(filing.spxReturn)
                            )
                            MetricTile(
                                title: "Excess",
                                value: Self.formatSignedPct(filing.excessReturn)
                            )
                        }
                    }
                    .padding(.top, 4)
                }

                if let from = perf.priceAtTrade ?? leg.priceAt, let to = perf.currentPrice {
                    let dateSuffix = perf.currentPriceDate.map { " (\($0))" } ?? ""
                    Text(String(format: "$%.2f → $%.2f%@", from, to, dateSuffix))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text("Observational price change for this politician’s trade, not portfolio P&L. Options are excluded.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if performance?.isOption == true {
                Text("Performance isn’t shown for options — return depends on strike, expiry, and exercise, which the filing doesn’t disclose.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Text(
                    performanceFailed
                        ? "Couldn’t load performance for this trade (timed out or market data unavailable)."
                        : "Price & performance vs the S&P 500 will appear when market data is available for this ticker."
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
        }
    }

    private func loadPerformance() async {
        performanceTask?.cancel()
        performanceLoaded = false
        performanceFailed = false
        performance = nil
        let txId = trade.id
        let task = Task {
            do {
                // Bounded timeout avoids CSCO / thin-history hangs hanging the sheet.
                let result = try await store.api.tradePerformance(txId: txId, timeout: 12)
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    performance = result
                    performanceFailed = false
                    performanceLoaded = true
                }
            } catch {
                guard !Task.isCancelled else { return }
                if let apiError = error as? APIError, apiError.isCancellation {
                    await MainActor.run {
                        performanceLoaded = true
                        performanceFailed = false
                    }
                    return
                }
                await MainActor.run {
                    performance = nil
                    performanceFailed = true
                    performanceLoaded = true
                }
            }
        }
        performanceTask = task
        await task.value
    }

    private static func formatSignedPct(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(format: "%+.1f%%", value * 100)
    }

    private var chamberGradient: Color {
        let chamber = trade.member.chamber?.lowercased() ?? ""
        if chamber == "house" { return AppTheme.houseColor }
        if chamber == "senate" { return AppTheme.senateColor }
        if chamber == "executive" { return AppTheme.execColor }
        return .blue
    }
}
