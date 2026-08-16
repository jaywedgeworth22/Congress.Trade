import SwiftUI

struct TrendsView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    /// Same `@AppStorage` keys as `FeedDashboardView` — the disclaimer's
    /// dismissed/expanded state is one truth across both tabs.  The filter
    /// strip lives in the same place as Trades (after the disclaimer, same
    /// 12pt gap, same 16/8 insets) so the chips and the top background match.
    @AppStorage("ct_disclaimer_expanded") private var disclaimerExpanded = true
    @AppStorage("ct_disclaimer_intro_done") private var disclaimerIntroDone = false
    @State private var selectedTicker: String?
    @State private var selectedPoliticianId: String?
    @State private var selectedPoliticianName: String?
    @State private var selectedPoliticianPhotoUrl: String?
    @State private var volumeMetric: VolumeChartMetric = .count

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                DisclaimerBanner(isExpanded: $disclaimerExpanded)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                FeedControlBar(showMetrics: false)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                    .background(.ultraThinMaterial)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if store.isLoadingTrends && store.analyticsSummary == nil {
                        ProgressView("Loading trends…")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 40)
                    } else {
                        if let notice = store.trendsNotice,
                           !Self.isBenignCancellationNotice(notice) {
                            NoticeView(message: notice)
                        }

                        summaryStrip

                        if !store.volumeSeries.isEmpty {
                            volumeSection
                        }

                        if !store.tickerLeaderboard.isEmpty {
                            tickerSection
                        }

                        if !store.trendingAssets.isEmpty {
                            trendingSection
                        }

                        if !store.clusterBuys.isEmpty {
                            clusterSection
                        }

                        sectorAndCapSection

                        if !store.topPerformers.isEmpty {
                            performersSection
                        }

                        if !store.memberLeaderboard.isEmpty {
                            memberSection
                        }

                        if !store.conflicts.isEmpty {
                            conflictsSection
                        }

                        if let lag = store.filingLag {
                            timelinessSection(lag: lag)
                        }

                        if let summary = store.latencySummary {
                            LatencyComparisonView(summary: summary)
                        }
                    }

                    // Same page-chrome row as Trades / Directory / Delivery.
                    // Owner punchlist: legal links at the bottom of every tab.
                    AppLegalFooter()
                        .padding(.top, 8)
                }
                // Same horizontal/top/bottom insets as Trades so the
                // disclaimer banner lands at an identical position/size on
                // both tabs (owner punch list item 2a — was `.padding(16)`
                // uniformly, 8pt further from the nav bar than Trades).
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            }
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // ⓘ now leads (swapped to match Trades' post-swap side —
                // owner punch list item 3); brand centers via .principal;
                // hamburger is the only trailing control.
                ToolbarItem(placement: .topBarLeading) {
                    HeaderIconButton(
                        systemImage: "info.circle",
                        accessibilityLabel: "About Congress.Trade"
                    ) {
                        withAnimation { disclaimerExpanded.toggle() }
                    }
                }
                ToolbarItem(placement: .principal) {
                    BrandTitle()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HamburgerMenuButton()
                }
            }
            .task {
                if store.analyticsSummary == nil {
                    await store.refreshTrends()
                }
                // One-time app-lifetime intro reveal, shared with Trades via
                // the same AppStorage keys — never re-plays on tab switch.
                if !disclaimerIntroDone {
                    disclaimerIntroDone = true
                    withAnimation { disclaimerExpanded = true }
                    try? await Task.sleep(for: .seconds(4))
                    if !Task.isCancelled {
                        withAnimation { disclaimerExpanded = false }
                    }
                }
            }
            .refreshable {
                await store.refreshTrends()
            }
            .sheet(isPresented: Binding<Bool>(
                get: { selectedTicker != nil },
                set: { if !$0 { selectedTicker = nil } }
            )) {
                if let ticker = selectedTicker {
                    TickerDetailView(ticker: ticker)
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                        .presentationCornerRadius(18)
                }
            }
            .sheet(isPresented: Binding<Bool>(
                get: { selectedPoliticianId != nil },
                set: { if !$0 { selectedPoliticianId = nil; selectedPoliticianPhotoUrl = nil } }
            )) {
                if let memberId = selectedPoliticianId {
                    PoliticianDetailView(
                        memberId: memberId,
                        memberName: selectedPoliticianName ?? "Politician",
                        seedPhotoUrl: selectedPoliticianPhotoUrl
                    )
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                        .presentationCornerRadius(18)
                }
            }
        }
    }

    private static func isBenignCancellationNotice(_ message: String) -> Bool {
        let lower = message.lowercased()
        return lower == "cancelled" || lower == "canceled"
            || lower.contains("cancelled") || lower.contains("canceled")
    }

    /// Extra top pad on later sections so the title sits closer to its own card
    /// than to the card above. Timeframe stays in the sticky filter row only.
    private func trendsHeading(_ title: String, extraTop: CGFloat = 10) -> some View {
        Text(title)
            .font(.headline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, extraTop)
            .accessibilityAddTraits(.isHeader)
    }

    private var summaryStrip: some View {
        let s = store.analyticsSummary
        return VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Market Snapshot", extraTop: 0)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                TrendKPI(title: "Trades", value: CompactFormat.count(s?.totalTrades))
                TrendKPI(title: "Politicians", value: CompactFormat.count(s?.uniqueMembers))
                TrendKPI(title: "Est. Volume", value: CompactFormat.usd(s?.estimatedVolumeUsd))
                // Signed, not colour-only: red/green alone fails for anyone who
                // can't separate the two, and the owner asked for the sign to
                // be readable. `SignedFlowFormat` also keeps a real $0 unsigned
                // and a missing value an em-dash — two different facts.
                TrendKPI(
                    title: "Net Flow",
                    value: SignedFlowFormat.usd(s?.estimatedNetFlowUsd),
                    tint: SignedFlowFormat.tint(s?.estimatedNetFlowUsd)
                )
                TrendKPI(title: "Buys", value: CompactFormat.count(s?.buyCount), tint: .green)
                TrendKPI(title: "Sells", value: CompactFormat.count(s?.sellCount), tint: .red)
            }
        }
    }

    private var volumeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                Text("Buys vs Sells")
                    .font(.headline)
                Spacer(minLength: 8)
                Picker("Metric", selection: $volumeMetric) {
                    ForEach(VolumeChartMetric.allCases) { metric in
                        Text(metric.label).tag(metric)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 88)
                .accessibilityLabel("Buys vs Sells metric")
            }
            .padding(.top, 10)

            let useDollars = volumeMetric == .dollars
            let totals: [Double] = store.volumeSeries.map { point in
                if useDollars {
                    return (point.estBuyVolUsd ?? 0) + (point.estSellVolUsd ?? 0)
                }
                return Double(point.buys + point.sells)
            }
            let maxVal = max(totals.max() ?? 1, 1)
            VStack(spacing: 6) {
                ForEach(store.volumeSeries.suffix(12)) { point in
                    let buyVal = useDollars ? (point.estBuyVolUsd ?? 0) : Double(point.buys)
                    let sellVal = useDollars ? (point.estSellVolUsd ?? 0) : Double(point.sells)
                    HStack(spacing: 8) {
                        Text(formatVolumePeriod(point.period))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(width: 72, alignment: .leading)
                        GeometryReader { geo in
                            HStack(spacing: 2) {
                                let buyW = geo.size.width * CGFloat(buyVal) / CGFloat(maxVal)
                                let sellW = geo.size.width * CGFloat(sellVal) / CGFloat(maxVal)
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color.green.opacity(0.75))
                                    .frame(width: max(buyW, buyVal > 0 ? 2 : 0))
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color.red.opacity(0.75))
                                    .frame(width: max(sellW, sellVal > 0 ? 2 : 0))
                                Spacer(minLength: 0)
                            }
                        }
                        .frame(height: 12)
                        Text(useDollars
                             ? CompactFormat.usd(buyVal + sellVal)
                             : CompactFormat.count(Int(buyVal + sellVal)))
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .frame(width: useDollars ? 64 : 50, alignment: .trailing)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        "\(formatVolumePeriod(point.period)), \(useDollars ? CompactFormat.usd(buyVal) : CompactFormat.count(Int(buyVal))) buys, \(useDollars ? CompactFormat.usd(sellVal) : CompactFormat.count(Int(sellVal))) sells"
                    )
                }
            }
            .padding(12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var tickerSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            trendsHeading("What Is Being Traded")
            VStack(spacing: 0) {
                ForEach(Array(store.tickerLeaderboard.prefix(10).enumerated()), id: \.element.id) { idx, item in
                    Button {
                        selectedTicker = item.ticker
                    } label: {
                        HStack(spacing: 10) {
                            Text("\(idx + 1)")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.secondary)
                                .frame(width: 18)
                            AssetMark(symbol: item.ticker, isTicker: true, size: 28)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.ticker)
                                    .font(.subheadline.weight(.bold))
                                Text(item.formattedName ?? "—")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 1) {
                                Text("\(item.tradeCount)")
                                    .font(.subheadline.weight(.bold))
                                Text(CompactFormat.usd(item.estVolumeUsd))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(item.ticker), \(item.formattedName ?? "—"), \(item.tradeCount) trades")
                    .accessibilityHint("Opens ticker details")
                    if idx < min(9, store.tickerLeaderboard.count - 1) {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var trendingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Rising Activity")
            VStack(spacing: 0) {
                ForEach(Array(store.trendingAssets.prefix(8).enumerated()), id: \.element.id) { idx, item in
                    Button {
                        selectedTicker = item.ticker
                    } label: {
                        HStack(spacing: 10) {
                            AssetMark(symbol: item.ticker, isTicker: true, size: 26)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.ticker)
                                    .font(.subheadline.weight(.bold))
                                Text("\(item.recentMembers ?? 0) politicians")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("\(item.priorCount) → \(item.recentCount) trades")
                                    .font(.caption.weight(.medium))
                                if let pct = item.changePct {
                                    Text("+\(Int(round(pct * 100)))%")
                                        .font(.caption2.weight(.bold))
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Color.green.opacity(0.15))
                                        .foregroundStyle(.green)
                                        .clipShape(Capsule())
                                }
                            }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(item.ticker), \(item.priorCount) to \(item.recentCount) trades")
                    .accessibilityHint("Opens ticker details")
                    if idx < min(7, store.trendingAssets.count - 1) {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var clusterSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Consensus Moves")
            VStack(spacing: 8) {
                ForEach(store.clusterBuys.prefix(8)) { c in
                    Button {
                        selectedTicker = c.ticker
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.ticker)
                                    .font(.subheadline.weight(.bold))
                                Text(c.formattedName ?? "")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            StatusPill(
                                text: (c.txType == "B" || c.txType == "P") ? "Buy" : (c.txType == "S" ? "Sell" : (c.txType == "E" ? "Exchange" : c.txType)),
                                color: (c.txType == "B" || c.txType == "P") ? .green : (c.txType == "S" ? .red : .blue),
                                compact: true
                            )
                            Text("\(c.memberCount) \(c.memberCount == 1 ? "politician" : "politicians")")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        .padding(10)
                        .frame(minHeight: 44)
                        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                        .contentShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(c.ticker), \(c.memberCount) \(c.memberCount == 1 ? "politician" : "politicians")")
                    .accessibilityHint("Opens ticker details")
                }
            }
        }
    }

    private var sectorAndCapSection: some View {
        Group {
            if horizontalSizeClass == .regular {
                HStack(alignment: .top, spacing: 18) {
                    sectorFlowCard
                        .frame(maxWidth: .infinity)
                    marketCapCard
                        .frame(maxWidth: .infinity)
                }
            } else {
                VStack(alignment: .leading, spacing: 18) {
                    sectorFlowCard
                    marketCapCard
                }
            }
        }
        .padding(.top, 10)
    }

    @ViewBuilder
    private var sectorFlowCard: some View {
        if !store.sectorFlow.isEmpty {
            let rows = SectorFlowRow.rows(from: store.sectorFlow, topCount: 8)
            VStack(alignment: .leading, spacing: 10) {
                trendsHeading("Net Flow by Sector", extraTop: 0)
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { idx, row in
                        HStack {
                            Text(row.label)
                                .font(.subheadline.weight(row.isAggregate ? .regular : .medium))
                                .foregroundStyle(row.isAggregate ? .secondary : .primary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                            Spacer(minLength: 12)
                            Text(SignedFlowFormat.usd(row.estNetFlowUsd))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(SignedFlowFormat.tint(row.estNetFlowUsd))
                                .lineLimit(1)
                        }
                        .padding(.vertical, 8)
                        .accessibilityElement(children: .combine)
                        if idx < rows.count - 1 {
                            Divider()
                        }
                    }
                }
                .padding(.horizontal, 12)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    @ViewBuilder
    private var marketCapCard: some View {
        if !store.marketCapBuckets.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                trendsHeading("By Market Cap", extraTop: 0)
                let caps = MarketCapOrder.sorted(store.marketCapBuckets)
                VStack(spacing: 0) {
                    ForEach(Array(caps.enumerated()), id: \.element.id) { idx, cap in
                        HStack(spacing: 8) {
                            Text(cap.bucket.capitalized)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                                .frame(maxWidth: 92, alignment: .leading)
                            Spacer(minLength: 4)
                            Text("\(cap.tradeCount) \(cap.tradeCount == 1 ? "trade" : "trades")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .frame(minWidth: 68, alignment: .trailing)
                            Text(SignedFlowFormat.usd(cap.estNetFlowUsd))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(SignedFlowFormat.tint(cap.estNetFlowUsd))
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                                .frame(width: 104, alignment: .trailing)
                        }
                        .padding(.vertical, 8)
                        if idx < caps.count - 1 {
                            Divider()
                        }
                    }
                }
                .padding(.horizontal, 12)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    /// Smallest number of disclosed buys a politician needs before the
    /// leaderboard will rank them. iOS sends no `minTrades`, so this mirrors the
    /// server default in `buildMemberPerformanceLeaderboardQuery`
    /// (`clampLimit(p.minTrades, 5, 1000)`, `app/src/analytics/builders.ts`).
    /// Shown on the card because the owner's standing worry about this section
    /// is "prone to having wild numbers" — an unlabelled small-N guard is
    /// exactly the thing that makes a 3-trade streak look like skill. Keep in
    /// sync with the builder if that default ever moves.
    static let performersMinBuys = 5

    /// Scope line under Top Performers.  Owner: "5+ buys", not "minimum…",
    /// and "+/-200% cap per trade" instead of "each trade capped at ±200%".
    /// The selected window lives on the heading, not here.
    static func performersScopeLine() -> String {
        "\(performersMinBuys)+ buys  •  stocks only  •  +/-200% cap per trade"
    }

    /// Caption under Disclosure Timeliness.  The window is already on the
    /// filter chips / heading — do not repeat "in this window".
    static func timelinessBasis(count: Int) -> String {
        "9 in 10 filings land inside the P90 figure.  Based on \(CompactFormat.count(count)) disclosed trades."
    }

    private var performersSection: some View {
        // Rank by the SAME statistic the row prints. The API already orders by
        // `avgExcessReturn`, so this is normally a no-op — it exists so the
        // list can never again arrive sorted by one field and be painted with
        // another (the cause of the owner's "odd order" report). Rows with no
        // score sort last rather than jumping to the top as 0.
        let ranked = store.topPerformers
            .sorted { ($0.avgExcessReturn ?? -.greatestFiniteMagnitude) > ($1.avgExcessReturn ?? -.greatestFiniteMagnitude) }
            .prefix(8)
        return VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Top Performers")
            // Benchmark named ONCE here instead of stamped on every row.
            // Wording mirrors the `note` field this endpoint returns
            // (`app/src/analytics/routes.ts`); iOS only decodes `members`, so
            // if that note is ever reworded, reword this too.
            Text("How far each politician's disclosed buys beat the S&P 500, measured from the filing date — the part a follower could have acted on.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(Self.performersScopeLine())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)

            VStack(spacing: 0) {
                ForEach(Array(ranked.enumerated()), id: \.element.id) { idx, p in
                    Button {
                        selectedPoliticianId = p.filerId
                        selectedPoliticianName = p.fullName ?? p.filerId
                        selectedPoliticianPhotoUrl = p.photoUrl
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.fullName ?? p.filerId)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text("\(p.tradeCount) buys")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            // `avgExcessReturn`, never `avgAnnualizedExcessReturn`
                            // — see the doc comments on `TopPerformerItem`.
                            Text(SignedPercentFormat.percent(p.avgExcessReturn))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(SignedFlowFormat.tint(p.avgExcessReturn))
                                .lineLimit(1)
                        }
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    // Spell the missing case out — VoiceOver would otherwise
                    // read the em-dash placeholder as "dash vs S and P 500".
                    .accessibilityLabel(
                        p.avgExcessReturn == nil
                            ? "\(p.fullName ?? p.filerId), \(p.tradeCount) buys, no score yet"
                            : "\(p.fullName ?? p.filerId), \(p.tradeCount) buys, \(SignedPercentFormat.percent(p.avgExcessReturn)) vs S&P 500"
                    )
                    .accessibilityHint("Opens politician details")
                    if idx < ranked.count - 1 {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var memberSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Most Active Politicians")
            VStack(spacing: 0) {
                ForEach(Array(store.memberLeaderboard.prefix(10).enumerated()), id: \.element.id) { idx, m in
                    Button {
                        selectedPoliticianId = m.filerId
                        selectedPoliticianName = m.fullName ?? m.filerId
                        selectedPoliticianPhotoUrl = nil
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(m.fullName ?? m.filerId)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text([m.chamber?.chamberLabel, m.party, m.state].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(m.tradeCount ?? 0)")
                                .font(.subheadline.weight(.bold))
                            Text("trades")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(m.fullName ?? m.filerId), \(m.tradeCount ?? 0) trades")
                    .accessibilityHint("Opens politician details")
                    if idx < min(9, store.memberLeaderboard.count - 1) {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var conflictsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Committee Sector Conflicts")
            Text("Disclosed trades in sectors that a politician's committees oversee (curated committee→sector map). Observational — not evidence of impropriety.")
                .font(.caption)
                .foregroundStyle(.secondary)

            VStack(spacing: 0) {
                ForEach(Array(store.conflicts.prefix(8).enumerated()), id: \.element.id) { idx, c in
                    Button {
                        selectedPoliticianId = c.bioguideId
                        selectedPoliticianName = c.memberName ?? c.bioguideId
                        selectedPoliticianPhotoUrl = c.photoUrl
                    } label: {
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.memberName ?? c.bioguideId)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text("\(c.committeeName ?? c.committeeCode) · \(c.sector)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(c.ticker)
                                    .font(.caption.weight(.bold))
                                StatusPill(
                                    text: c.txType == "B" ? "Buy" : (c.txType == "S" ? "Sell" : "Exchange"),
                                    color: c.txType == "B" ? .green : (c.txType == "S" ? .red : .blue),
                                    compact: true
                                )
                            }
                        }
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if idx < min(7, store.conflicts.count - 1) {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func timelinessSection(lag: FilingLagResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            trendsHeading("Disclosure Timeliness")
            Text("Days from trade to official filing date (45-day STOCK Act limit).")
                .font(.caption)
                .foregroundStyle(.secondary)

            // Median / P90 / >45 days — the three figures this endpoint
            // actually returns, and the same three the website shows. The old
            // trio asked for `avgLagDays` and `lateCount`, which have never
            // been in the payload; Optional decoding hid that and shipped
            // "Avg Delay: 0 days" as if it were measured. Every value falls
            // back to an em-dash, never to a zero that reads as a real answer.
            if let s = lag.summary {
                HStack(spacing: 12) {
                    TrendKPI(title: "Median Delay", value: Self.daysLabel(s.medianLagDays))
                    TrendKPI(title: "P90 Delay", value: Self.daysLabel(s.p90LagDays))
                    TrendKPI(
                        title: "Over 45 Days",
                        value: SignedPercentFormat.plainPercent(s.overFortyFivePct),
                        tint: (s.overFortyFivePct ?? 0) > 0 ? .orange : .green
                    )
                }
                if let count = s.count, count > 0 {
                    Text(Self.timelinessBasis(count: count))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if let late = lag.topLateFilers, !late.isEmpty {
                Text("Slowest Filers (Avg Delay)")
                    .font(.subheadline.weight(.bold))
                    .padding(.top, 6)
                VStack(spacing: 0) {
                    ForEach(Array(late.prefix(6).enumerated()), id: \.element.id) { idx, f in
                        Button {
                            selectedPoliticianId = f.filerId
                            selectedPoliticianName = f.fullName ?? f.filerId
                            selectedPoliticianPhotoUrl = f.photoUrl
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(f.fullName ?? f.filerId)
                                        .font(.subheadline.weight(.medium))
                                        .lineLimit(1)
                                    Text("\(f.tradeCount ?? 0) trades")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("\(Int(round(f.avgLagDays ?? 0)))d avg")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(.orange)
                            }
                            .padding(.vertical, 6)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(f.fullName ?? f.filerId), \(Int(round(f.avgLagDays ?? 0))) days average delay")
                        .accessibilityHint("Opens politician details")
                        if idx < min(5, late.count - 1) {
                            Divider()
                        }
                    }
                }
                .padding(.horizontal, 12)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    /// Whole-day label for a filing-lag figure. A missing value is an em-dash,
    /// NOT "0 days" — "we don't have this" and "they filed same-day" are
    /// opposite claims and must never render identically.
    private static func daysLabel(_ days: Double?) -> String {
        guard let days else { return "—" }
        let whole = Int(days.rounded())
        return "\(whole) \(whole == 1 ? "day" : "days")"
    }

    private func formatVolumePeriod(_ period: String) -> String {
        let parts = period.split(separator: "-")
        if parts.count == 2, let year = Int(parts[0]) {
            let numStr = parts[1]
            if numStr.hasPrefix("W"), let num = Int(numStr.dropFirst()) {
                // Week (e.g. 2026-W18)
                var components = DateComponents()
                components.yearForWeekOfYear = year
                components.weekOfYear = num
                components.weekday = 2
                let cal = Calendar(identifier: .gregorian)
                if let date = cal.date(from: components) {
                    let fmt = DateFormatter()
                    fmt.dateFormat = "MMM d"
                    return fmt.string(from: date)
                }
            } else if let num = Int(numStr) {
                // Month (e.g. 2026-05)
                var components = DateComponents()
                components.year = year
                components.month = num
                let cal = Calendar(identifier: .gregorian)
                if let date = cal.date(from: components) {
                    let fmt = DateFormatter()
                    fmt.dateFormat = "MMM yyyy"
                    return fmt.string(from: date)
                }
            }
        } else if parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) {
            // Day (e.g. 2026-05-04)
            var components = DateComponents()
            components.year = year
            components.month = month
            components.day = day
            let cal = Calendar(identifier: .gregorian)
            if let date = cal.date(from: components) {
                let fmt = DateFormatter()
                fmt.dateFormat = "MMM d"
                return fmt.string(from: date)
            }
        }
        return period
    }
}

/// Signed money for net-flow readouts.
///
/// Colour alone must not carry the sign: it is invisible to a large share of
/// readers and it disappears entirely in a screenshot or a VoiceOver pass. So
/// an inflow prints "net +$" style — `+$952k` — and an outflow keeps the `-`
/// that `CompactFormat.usd` already supplies.
///
/// Two cases are deliberately NOT signed. A genuine zero is neither positive
/// nor negative, so "+$0" would be a small lie; and a missing value stays an
/// em-dash so "nothing flowed" and "we have no figure" never look the same.
enum SignedFlowFormat {
    static func usd(_ value: Double?) -> String {
        guard let value else { return "—" }
        let base = CompactFormat.usd(value)
        // Test the RENDERED string, not the raw double: a sub-dollar residue
        // would otherwise print as a signed "+$0".
        guard value > 0, base != "$0" else { return base }
        return "+" + base
    }

    /// Green up / red down, but neutral for a real zero and for no-data — those
    /// two carry no direction to colour.
    static func tint(_ value: Double?) -> Color {
        guard let value, value != 0 else { return .primary }
        return value > 0 ? .green : .red
    }
}

/// Percentages that come off the API as fractions (0.0567 → 5.7%).
enum SignedPercentFormat {
    /// Signed, for return figures where direction is the whole point.
    static func percent(_ fraction: Double?) -> String {
        guard let fraction else { return "—" }
        let pct = fraction * 100
        // Round first, then decide the sign, so a value that rounds to 0.0
        // prints a bare "0.0%" instead of a misleading "+0.0%".
        let rounded = (pct * 10).rounded() / 10
        if rounded == 0 { return "0.0%" }
        return String(format: "%+.1f%%", rounded)
    }

    /// Unsigned, for shares of a total (a proportion has no direction).
    /// Sub-tenth-of-a-percent shares collapse to "<0.1%" rather than to a "0%"
    /// that would read as "never happens".
    static func plainPercent(_ fraction: Double?) -> String {
        guard let fraction else { return "—" }
        let pct = fraction * 100
        if pct == 0 { return "0%" }
        if pct < 0.1 { return "<0.1%" }
        if pct >= 10 { return String(format: "%.0f%%", pct) }
        return String(format: "%.1f%%", pct)
    }
}

/// Size ladder for the market-cap buckets `securities_ref.market_cap_bucket`
/// emits. `/market-cap-breakdown` runs a bare `GROUP BY bucket` with no ORDER
/// BY, so rows arrive alphabetically — Large above Mega, Micro above Mid. Any
/// label the ladder does not know (including the `unknown` sentinel) sorts to
/// the end rather than into the middle of the ladder.
enum MarketCapOrder {
    private static let rank = ["mega": 0, "large": 1, "mid": 2, "small": 3, "micro": 4, "nano": 5]

    static func sorted(_ buckets: [MarketCapItem]) -> [MarketCapItem] {
        buckets.sorted { a, b in
            let ra = rank[a.bucket.lowercased()] ?? Int.max
            let rb = rank[b.bucket.lowercased()] ?? Int.max
            // Stable tail: two unranked labels keep a predictable A→Z order
            // instead of whatever the server happened to emit.
            if ra == rb { return a.bucket.lowercased() < b.bucket.lowercased() }
            return ra < rb
        }
    }
}

/// One rendered row of "Net Flow by Sector".
///
/// `GET /api/analytics/sector-flow` returns the most-traded sectors ordered by
/// trade count (server default LIMIT 20). iOS used to paint `prefix(8)` and
/// silently drop the tail — at window=90d that hid a majority of the sectors
/// and, because one of the discards was a large outflow, the visible rows did
/// not add up to anything the reader could check. Every returned sector now
/// lands somewhere: the top 8 by name, the remainder folded into one "Other"
/// row that says how many sectors it covers, and "Unknown" kept as its own
/// trailing row so unenriched trades are never quietly mixed into "Other".
///
/// DUPLICATE LABELS ARE EXPECTED AND MUST BE MERGED. Verified live on
/// 2026-08-11 at `?window=90d`: the payload carried 'Technology' twice,
/// 'Healthcare' three times, 'Communication Services' three times and
/// 'Industrials' three times, each as its own bucket. (The canonicalizing
/// `CASE` is in the SELECT list while `GROUP BY sector` binds to the underlying
/// `sr.sector` column, so the server groups on the raw vocabulary and only
/// relabels — a backend defect, reported separately.) Two consequences the view
/// cannot ignore: identical `id`s corrupt a SwiftUI `ForEach`, and two rows
/// reading "Healthcare  −$40k" side by side is worse than either number alone.
/// Rows are therefore merged by label and given index-derived ids. When the
/// backend groups correctly the merge is a no-op.
private struct SectorFlowRow: Identifiable {
    let id: String
    let label: String
    let estNetFlowUsd: Double?
    /// Aggregate rows (Other / Unknown) are de-emphasised — they name a bucket,
    /// not a sector anyone chose to trade.
    let isAggregate: Bool

    /// A label's combined trade count and net flow. `netFlow` stays nil until a
    /// bucket actually reports one, so "no figure" never becomes a $0 claim.
    private struct Merged {
        var label: String
        var tradeCount: Int
        var netFlow: Double?
    }

    static func rows(from sectors: [SectorFlowItem], topCount: Int) -> [SectorFlowRow] {
        // Fold duplicate labels first, preserving first-seen order so the
        // server's trade-count ranking still drives the result when the payload
        // is already clean.
        var order: [String] = []
        var merged: [String: Merged] = [:]
        for item in sectors {
            let key = item.sector.lowercased()
            if merged[key] == nil {
                order.append(key)
                merged[key] = Merged(label: item.sector, tradeCount: 0, netFlow: nil)
            }
            var entry = merged[key] ?? Merged(label: item.sector, tradeCount: 0, netFlow: nil)
            entry.tradeCount += item.tradeCount ?? 0
            if let flow = item.estNetFlowUsd {
                entry.netFlow = (entry.netFlow ?? 0) + flow
            }
            merged[key] = entry
        }
        // Re-rank after merging: two halves of one sector each looked smaller
        // than they are, so the pre-merge order can no longer be trusted.
        let ranked = order.compactMap { merged[$0] }.sorted {
            ($0.netFlow ?? 0) > ($1.netFlow ?? 0)
        }

        // "Unknown" is pulled out BEFORE ranking is applied to the top slots.
        // Leaving it in would let a data-quality bucket take a top-8 slot from a
        // real sector.
        let unknown = ranked.filter { $0.label.caseInsensitiveCompare("Unknown") == .orderedSame }
        let named = ranked.filter { $0.label.caseInsensitiveCompare("Unknown") != .orderedSame }

        var out = named.prefix(topCount).enumerated().map { idx, m in
            // Index-derived id: a repeated label can never collide even if the
            // merge above is ever bypassed.
            SectorFlowRow(id: "\(idx)-\(m.label)", label: m.label, estNetFlowUsd: m.netFlow, isAggregate: false)
        }

        let rest = named.dropFirst(topCount)
        if !rest.isEmpty {
            // Sum only the sectors that reported a figure; if none did, stay an
            // em-dash rather than claiming a $0 net.
            let scored = rest.compactMap(\.netFlow)
            out.append(
                SectorFlowRow(
                    id: "__other__",
                    label: "Other (\(rest.count) \(rest.count == 1 ? "sector" : "sectors"))",
                    estNetFlowUsd: scored.isEmpty ? nil : scored.reduce(0, +),
                    isAggregate: true
                )
            )
        }

        if !unknown.isEmpty {
            let scored = unknown.compactMap(\.netFlow)
            out.append(
                SectorFlowRow(
                    id: "__unknown__",
                    label: "Unknown",
                    estNetFlowUsd: scored.isEmpty ? nil : scored.reduce(0, +),
                    isAggregate: true
                )
            )
        }
        return out
    }
}

private enum VolumeChartMetric: String, CaseIterable, Identifiable {
    case count
    case dollars

    var id: String { rawValue }

    var label: String {
        switch self {
        case .count: return "#"
        case .dollars: return "$"
        }
    }
}

struct TrendKPI: View {
    let title: String
    let value: String
    var tint: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.headline.weight(.bold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct LatencyComparisonView: View {
    let summary: LatencySummary
    let minMatched = 2

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Speed vs. Data Providers")
                .font(.headline)
                .padding(.top, 10)
            Text("Live new imports only (seed/historical backfills excluded). Matched against provider feeds even if the gap is minutes or up to about two weeks either way.")
                .font(.caption)
                .foregroundStyle(.secondary)

            let sortedProviders = summary.providers.sorted { $0.matched > $1.matched }

            ForEach(sortedProviders) { provider in
                ProviderScorecard(provider: provider, minMatched: minMatched)
            }
        }
    }
}

/// Presentation for one provider scorecard.
///
/// Sign convention matches web (`dashboardHtml.ts` leadDirection): positive
/// seconds means Congress.Trade published first.  The headline is the median
/// so one freak race cannot flip the sign the way the mean did on iOS
/// (FMP live 2026-08-16: median +13.0h, average −4.6d).  Colour follows the
/// headline sign — + green when we are early, − red when we are late —
/// never the win-count badge.
enum LatencyScorecardCopy {
    enum Direction: Equatable {
        case ahead, behind, even
    }

    struct Snapshot: Equatable {
        var hasStats: Bool
        var headlineText: String
        var direction: Direction
        var badgeText: String
        var basisLabel: String
        var winPct: Int
        var averageDisagrees: Bool
        var averageCaption: String?
    }

    static func formatLead(_ secs: Int?) -> String {
        guard let s = secs else { return "—" }
        let absS = abs(Double(s))
        let sign = s > 0 ? "+" : (s < 0 ? "−" : "")
        if absS < 90 { return "\(sign)\(Int(round(absS)))s" }
        if absS < 5400 { return "\(sign)\(Int(round(absS / 60)))m" }
        if absS < 172800 { return "\(sign)\(String(format: "%.1f", absS / 3600))h" }
        return "\(sign)\(String(format: "%.1f", absS / 86400))d"
    }

    static func direction(of secs: Int?) -> Direction {
        guard let s = secs, s != 0 else { return .even }
        return s > 0 ? .ahead : .behind
    }

    static func snapshot(for provider: LatencyProvider, minMatched: Int = 2) -> Snapshot {
        let status = provider.comparisonStatus ?? "insufficient"
        let usable = status == "usable"
        let preliminary = status == "preliminary"
        let wins = provider.usFirstCount
        let losses = provider.providerFirstCount
        let ties = provider.tieCount
        let deltaSample = wins + losses + ties
        let headlineSec = provider.medianLeadSec ?? provider.avgLeadSec
        let hasLead = headlineSec != nil
        let hasTiming = provider.matched >= minMatched && deltaSample > 0 && hasLead
        let hasStats = hasTiming && (usable || preliminary)
        let direction = direction(of: headlineSec)
        let winPct = provider.matched > 0
            ? Int(round(100.0 * Double(wins) / Double(provider.matched)))
            : 0

        let badgeText: String
        if !hasStats {
            badgeText = (provider.matched >= minMatched && !usable) ? "Coverage limited" : "Gathering"
        } else if preliminary {
            switch direction {
            case .ahead: badgeText = "Preliminary lead"
            case .behind: badgeText = "Preliminary behind"
            case .even: badgeText = "Preliminary tie"
            }
        } else {
            switch direction {
            case .ahead: badgeText = "Ahead"
            case .behind: badgeText = "Behind"
            case .even: badgeText = "Tied"
            }
        }

        let word = direction == .behind ? "lag" : (direction == .even ? "even" : "lead")
        let basisLabel: String
        if !hasStats {
            basisLabel = ""
        } else if direction == .even {
            basisLabel = preliminary ? "prelim. typical even" : "typical even"
        } else {
            basisLabel = preliminary ? "prelim. typical \(word)" : "typical \(word)"
        }

        let avgDir = direction(of: provider.avgLeadSec)
        let averageDisagrees = hasStats
            && provider.avgLeadSec != nil
            && provider.medianLeadSec != nil
            && avgDir != direction
            && avgDir != .even
            && direction != .even
        let averageCaption = averageDisagrees
            ? "Average \(formatLead(provider.avgLeadSec)) — a few outlier races pull it the other way."
            : nil

        return Snapshot(
            hasStats: hasStats,
            headlineText: formatLead(headlineSec),
            direction: direction,
            badgeText: badgeText,
            basisLabel: basisLabel,
            winPct: winPct,
            averageDisagrees: averageDisagrees,
            averageCaption: averageCaption
        )
    }
}

struct ProviderScorecard: View {
    let provider: LatencyProvider
    let minMatched: Int

    var body: some View {
        let snap = LatencyScorecardCopy.snapshot(for: provider, minMatched: minMatched)
        let status = provider.comparisonStatus ?? "insufficient"
        let hasLead = provider.avgLeadSec != nil || provider.medianLeadSec != nil

        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(provider.label)
                    .font(.subheadline.weight(.bold))
                Spacer()
                badge(snap.badgeText, kind: badgeKind(snap: snap, preliminary: status == "preliminary"))
            }

            if snap.hasStats {
                HStack(alignment: .firstTextBaseline) {
                    Text(snap.headlineText)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(leadColor(snap.direction))
                    Text(snap.basisLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(snap.winPct)% win")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                if let caption = snap.averageCaption {
                    Text(caption)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            } else {
                let unmatched = provider.unmatchedProvider ?? 0
                let strong = provider.strongMatched
                let strongNote: String = {
                    if let s = strong, s > provider.matched {
                        return " \(s) strong overlaps total."
                    }
                    return ""
                }()
                Text(
                    provider.matched > 0 && !hasLead
                        ? "Matched \(provider.matched) races but no usable first-seen timestamps for lead/lag yet."
                            + strongNote
                        : provider.matched > 0
                        ? "Timed \(provider.matched) concurrent races of \(provider.candidates) CT filings so far."
                            + strongNote
                            + (unmatched > 0 ? " \(unmatched) provider-only rows still unmatched." : "")
                        : "Probes haven't found concurrent races yet."
                            + strongNote
                )
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private func leadColor(_ direction: LatencyScorecardCopy.Direction) -> Color {
        switch direction {
        case .ahead: return .green
        case .behind: return .red
        case .even: return .primary
        }
    }

    private enum BadgeKind { case preliminary, ahead, behind, muted }

    private func badgeKind(snap: LatencyScorecardCopy.Snapshot, preliminary: Bool) -> BadgeKind {
        if !snap.hasStats || preliminary { return .preliminary }
        switch snap.direction {
        case .ahead: return .ahead
        case .behind: return .behind
        case .even: return .muted
        }
    }

    private func badge(_ text: String, kind: BadgeKind) -> some View {
        let bg: Color
        let fg: Color
        switch kind {
        case .preliminary:
            bg = Color.orange.opacity(0.15)
            fg = .orange
        case .ahead:
            bg = Color.green.opacity(0.2)
            fg = .green
        case .behind:
            bg = Color.red.opacity(0.2)
            fg = .red
        case .muted:
            bg = Color.gray.opacity(0.2)
            fg = Color.secondary
        }
        return Text(text)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(bg).foregroundStyle(fg).clipShape(Capsule())
    }
}
