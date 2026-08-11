import SwiftUI

struct TrendsView: View {
    @EnvironmentObject private var store: CongressTradeStore
    /// Same `@AppStorage` keys as `FeedDashboardView` — the disclaimer's
    /// dismissed/expanded state is one truth across both tabs (owner punch
    /// list item 2b), and identical top/side insets keep its position/size
    /// pixel-identical to Trades (item 2a).
    @AppStorage("ct_disclaimer_expanded") private var disclaimerExpanded = true
    @AppStorage("ct_disclaimer_intro_done") private var disclaimerIntroDone = false
    @State private var selectedTicker: String?
    @State private var selectedPoliticianId: String?
    @State private var selectedPoliticianName: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                // `LazyVStack` + `pinnedViews: [.sectionHeaders]` is what makes
                // the filter bar sticky: everything the owner wants to keep on
                // screen goes in the Section HEADER, everything that should
                // scroll away goes above the Section or inside its content.
                // The banner sits outside the Section so it still scrolls off —
                // only the filters are pinned. Lazy also means the long tail of
                // Trends cards is not built until it is scrolled toward.
                LazyVStack(alignment: .leading, spacing: 16, pinnedViews: [.sectionHeaders]) {
                    DisclaimerBanner(isExpanded: $disclaimerExpanded)
                        .padding(.horizontal, 16)

                    Section {
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

                                if let lag = store.filingLag {
                                    timelinessSection(lag: lag)
                                }

                                if let summary = store.latencySummary {
                                    LatencyComparisonView(summary: summary)
                                }

                                LegalFooterLinks()
                            }
                        }
                        // Same 16pt side inset the whole page used to carry —
                        // moved onto the content so the pinned header's
                        // background can run edge to edge behind it.
                        .padding(.horizontal, 16)
                        .padding(.bottom, 24)
                    } header: {
                        stickyFilterHeader
                    }
                }
                // Matches Trades' top inset so the disclaimer banner lands at an
                // identical position/size on both tabs (owner punch list 2a).
                .padding(.top, 8)
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
                set: { if !$0 { selectedPoliticianId = nil } }
            )) {
                if let memberId = selectedPoliticianId {
                    PoliticianDetailView(memberId: memberId, memberName: selectedPoliticianName ?? "Politician")
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

    /// The pinned section header. Opaque `AppTheme.background` is load-bearing:
    /// a pinned header is drawn over the scrolling content, so anything less
    /// than opaque lets rows smear through it as they pass underneath.
    private var stickyFilterHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Identical shared filters as Trades (no export, no politician/asset extras).
            FeedControlBar(showMetrics: false)

            // A filter change re-runs eleven analytics queries and can take
            // several seconds; without this the tab looks frozen and the owner
            // reasonably concluded the filter "just isn't working". Only shown
            // on a re-fetch — the first load already has its own ProgressView.
            if store.isLoadingTrends && store.analyticsSummary != nil {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.mini)
                    Text("Updating for the new filters…")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .transition(.opacity)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Updating trends for the new filters")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.background)
        .overlay(alignment: .bottom) {
            Divider()
        }
        .animation(.easeInOut(duration: 0.2), value: store.isLoadingTrends)
    }

    /// What the analytics calls actually cover, which is not always what the
    /// pill says: `refreshTrends` sends `TimeRange.analyticsWindow`, and that
    /// maps All Time to `1825d` and both calendar-year options to `365d`.
    /// Guardrail copy has to state the real span or it is just a nicer-looking
    /// lie. Lowercased for use mid-sentence.
    private var analyticsWindowPhrase: String {
        switch store.selectedTimeRange {
        case .thisCalendarYear, .lastCalendarYear: return "past year"
        case .all: return "past 5 years"
        default: return store.selectedTimeRange.label.lowercased()
        }
    }

    private var summaryStrip: some View {
        let s = store.analyticsSummary
        return VStack(alignment: .leading, spacing: 10) {
            Text("Market Snapshot")
                .font(.headline)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                TrendKPI(title: "Trades", value: CompactFormat.count(s?.totalTrades))
                TrendKPI(title: "Politicians", value: CompactFormat.count(s?.uniqueMembers))
                TrendKPI(title: "Est. Volume", value: CompactFormat.usd(s?.estimatedVolumeUsd))
                TrendKPI(
                    title: "Net Flow",
                    value: TrendsFormat.signedUsd(s?.estimatedNetFlowUsd),
                    tint: (s?.estimatedNetFlowUsd ?? 0) >= 0 ? .green : .red
                )
                TrendKPI(title: "Buys", value: CompactFormat.count(s?.buyCount), tint: .green)
                TrendKPI(title: "Sells", value: CompactFormat.count(s?.sellCount), tint: .red)
            }
        }
    }

    private var volumeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Buys vs Sells Over Time")
                .font(.headline)
            Text("Trade counts bucketed by period over selected window.")
                .font(.caption)
                .foregroundStyle(.secondary)

            let maxCount = max(store.volumeSeries.map { $0.buys + $0.sells }.max() ?? 1, 1)
            VStack(spacing: 6) {
                ForEach(store.volumeSeries.suffix(12)) { point in
                    HStack(spacing: 8) {
                        Text(formatVolumePeriod(point.period))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(width: 72, alignment: .leading)
                        GeometryReader { geo in
                            HStack(spacing: 2) {
                                let buyW = geo.size.width * CGFloat(point.buys) / CGFloat(maxCount)
                                let sellW = geo.size.width * CGFloat(point.sells) / CGFloat(maxCount)
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color.green.opacity(0.75))
                                    .frame(width: max(buyW, point.buys > 0 ? 2 : 0))
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(Color.red.opacity(0.75))
                                    .frame(width: max(sellW, point.sells > 0 ? 2 : 0))
                                Spacer(minLength: 0)
                            }
                        }
                        .frame(height: 12)
                        Text("\(point.buys + point.sells)")
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .frame(width: 50, alignment: .trailing)
                    }
                }
            }
            .padding(12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var tickerSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What Congress Is Trading")
                .font(.headline)
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
            Text("Rising Activity")
                .font(.headline)
            Text("Assets whose trade count rose most vs prior equal period.")
                .font(.caption)
                .foregroundStyle(.secondary)
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
            Text("Consensus Moves")
                .font(.headline)
            Text("Assets several politicians traded the same direction in this window.")
                .font(.caption)
                .foregroundStyle(.secondary)
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

    /// One row of a three-column flow ledger. Sector and market cap were two
    /// different layouts (sector had no trade count, market cap right-aligned
    /// its money against a `Spacer`), which is why they read as unrelated
    /// tables sitting on top of each other. One row type, one geometry.
    private struct FlowRow: Identifiable {
        let id: String
        let name: String
        let tradeCount: Int?
        let netFlowUsd: Double?
        /// Residual/unattributed rows (Other, Unknown) are de-emphasised so
        /// they read as bookkeeping rather than as another real category.
        var isMuted: Bool = false
    }

    /// Column widths, shared by both ledgers so the two cards line up.
    /// Owner ask, verbatim: make the far-right column wider and the name
    /// column narrower, keep the middle and right columns right-aligned, and
    /// put a bit more air between the right two. The 14pt HStack spacing is
    /// that air; the fixed widths are what stops the money column jittering
    /// row to row.
    private static let flowCountColumnWidth: CGFloat = 62
    private static let flowMoneyColumnWidth: CGFloat = 96

    private func flowLedger(_ rows: [FlowRow]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { idx, row in
                HStack(spacing: 14) {
                    Text(row.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(row.isMuted ? .secondary : .primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(row.tradeCount.map { "\($0) trades" } ?? "—")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(width: Self.flowCountColumnWidth, alignment: .trailing)
                    Text(TrendsFormat.signedUsd(row.netFlowUsd))
                        .font(.subheadline.weight(.bold).monospacedDigit())
                        .foregroundStyle((row.netFlowUsd ?? 0) >= 0 ? .green : .red)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(width: Self.flowMoneyColumnWidth, alignment: .trailing)
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

    /// Top 8 named sectors, then a single "Other" row carrying everything else
    /// the API returned, then "Unknown" if the API emitted it. Before this the
    /// tab took `prefix(8)` and silently dropped the rest — about a third of
    /// the tickered trades vanished with nothing on screen saying so, and the
    /// net-flow column added up to a number no one could reconcile.
    private var sectorFlowRows: [FlowRow] {
        let isUnknown = { (s: SectorFlowItem) in
            s.sector.caseInsensitiveCompare("Unknown") == .orderedSame
        }
        let unknown = store.sectorFlow.first(where: isUnknown)
        let named = store.sectorFlow.filter { !isUnknown($0) }

        var rows = named.prefix(8).map {
            FlowRow(id: $0.sector, name: $0.sector, tradeCount: $0.tradeCount, netFlowUsd: $0.estNetFlowUsd)
        }
        let rest = named.dropFirst(8)
        if !rest.isEmpty {
            rows.append(FlowRow(
                id: "__other__",
                // Say how much is folded in — a bare "Other" invites the reader
                // to assume it is one small leftover category.
                name: "Other (\(rest.count) \(rest.count == 1 ? "sector" : "sectors"))",
                tradeCount: rest.reduce(0) { $0 + ($1.tradeCount ?? 0) },
                netFlowUsd: rest.reduce(0.0) { $0 + ($1.estNetFlowUsd ?? 0) },
                isMuted: true
            ))
        }
        if let unknown {
            rows.append(FlowRow(
                id: "__unknown__",
                name: "Unknown",
                tradeCount: unknown.tradeCount,
                netFlowUsd: unknown.estNetFlowUsd,
                isMuted: true
            ))
        }
        return rows
    }

    /// Cap buckets arrive alphabetically (large, mega, micro, mid, nano,
    /// small, unknown), which puts mega below large and micro above mid — an
    /// order with no meaning to a reader. Sort by actual company size, biggest
    /// first, with the unattributed bucket last.
    private static let capBucketOrder = ["mega", "large", "mid", "small", "micro", "nano"]

    private var marketCapRows: [FlowRow] {
        store.marketCapBuckets
            .sorted { a, b in
                let ai = Self.capBucketOrder.firstIndex(of: a.bucket.lowercased()) ?? Self.capBucketOrder.count
                let bi = Self.capBucketOrder.firstIndex(of: b.bucket.lowercased()) ?? Self.capBucketOrder.count
                return ai == bi ? a.bucket < b.bucket : ai < bi
            }
            .map { cap in
                let isKnown = Self.capBucketOrder.contains(cap.bucket.lowercased())
                return FlowRow(
                    id: cap.bucket,
                    name: isKnown ? "\(cap.bucket.capitalized) Cap" : cap.bucket.capitalized,
                    tradeCount: cap.tradeCount,
                    netFlowUsd: cap.estNetFlowUsd,
                    isMuted: !isKnown
                )
            }
    }

    private var sectorAndCapSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            if !store.sectorFlow.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Net Flow by Sector")
                        .font(.headline)
                    Text("Sectors come from ticker enrichment, so trades without a resolved ticker are not counted here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    flowLedger(sectorFlowRows)
                }
            }

            if !store.marketCapBuckets.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("By Market Cap")
                        .font(.headline)
                    Text("Same tickered trades, grouped by company size instead of sector.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    flowLedger(marketCapRows)
                }
            }
        }
    }

    /// `/member-performance` clamps `minTrades` with a default of 5
    /// (`buildMemberPerformanceLeaderboardQuery`), and the iOS client sends no
    /// `minTrades` param — so 5 is genuinely the live floor. Stated on the card
    /// rather than assumed, because "top performer" with no visible sample-size
    /// rule is exactly the kind of number the owner flagged as misleading.
    private static let performersMinBuys = 5

    private var performersSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Benchmark named once here, in the descriptive text, instead of
            // "SPX" repeated on every row and "S&P 500" in the title (owner:
            // pick one name and say it once).
            Text("Top Performers")
                .font(.headline)
            Text("How politicians' disclosed buys have done against the S&P 500, measured from the filing date — the first day a follower could actually have bought.")
                .font(.caption)
                .foregroundStyle(.secondary)

            // Guardrail strip: the two facts that decide whether a row on this
            // board means anything — how far back it looks, and how many buys
            // a politician needs before they can appear at all.
            HStack(spacing: 0) {
                Text(analyticsWindowPhrase.capitalizedFirstLetter)
                Text("  •  ")
                Text("\(Self.performersMinBuys)+ disclosed buys")
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)

            VStack(spacing: 0) {
                ForEach(Array(store.topPerformers.prefix(8).enumerated()), id: \.element.id) { idx, p in
                    Button {
                        selectedPoliticianId = p.filerId
                        selectedPoliticianName = p.fullName ?? p.filerId
                    } label: {
                        HStack(spacing: 14) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.fullName ?? p.filerId)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text(performerSubtitle(p))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.85)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            // `avgExcessReturn`, NOT `avgAnnualizedExcessReturn`.
                            // The API sorts by this field and the web board shows
                            // it; iOS painted the annualized one, so the rows
                            // arrived in one order and were labelled with another
                            // (hence "the order is odd") and a 30-day-old trade's
                            // ~12x annualization multiplier turned a real 5.7%
                            // into a headline 41%.
                            if let ret = p.avgExcessReturn {
                                Text(String(format: "%+.1f%%", ret * 100))
                                    .font(.subheadline.weight(.bold).monospacedDigit())
                                    .foregroundStyle(ret >= 0 ? .green : .red)
                                    .lineLimit(1)
                            }
                        }
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(performerAccessibilityLabel(p))
                    .accessibilityHint("Opens politician details")
                    if idx < min(7, store.topPerformers.count - 1) {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))

            Text("Size-weighted average, capped at ±200% per trade so one runaway position cannot set the ranking.  0% means the buys matched the S&P 500.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func performerSubtitle(_ p: TopPerformerItem) -> String {
        let buys = "\(p.tradeCount) \(p.tradeCount == 1 ? "buy" : "buys")"
        // `winRate` is the share of those buys that beat the benchmark — the
        // context that stops a single lucky name reading as a track record.
        guard let win = p.winRate else { return buys }
        return "\(buys)  •  \(Int(round(win * 100)))% beat the S&P"
    }

    private func performerAccessibilityLabel(_ p: TopPerformerItem) -> String {
        let name = p.fullName ?? p.filerId
        guard let ret = p.avgExcessReturn else {
            return "\(name), \(p.tradeCount) buys"
        }
        let pct = String(format: "%.1f", abs(ret * 100))
        return "\(name), \(p.tradeCount) buys, \(pct) percent \(ret >= 0 ? "above" : "below") the S&P 500"
    }

    private var memberSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Most Active Politicians")
                .font(.headline)
            VStack(spacing: 0) {
                ForEach(Array(store.memberLeaderboard.prefix(10).enumerated()), id: \.element.id) { idx, m in
                    Button {
                        selectedPoliticianId = m.filerId
                        selectedPoliticianName = m.fullName ?? m.filerId
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

    private func timelinessSection(lag: FilingLagResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Disclosure Timeliness")
                .font(.headline)
            Text(timelinessCaption(lag.summary))
                .font(.caption)
                .foregroundStyle(.secondary)

            // Median / 90th percentile / over-45-days is exactly what
            // `summarizeLag` returns and what the web tiles show. The previous
            // three tiles read `avgLagDays` and `lateCount`, which this
            // endpoint has never emitted — the optional decode swallowed it and
            // shipped a permanent "Avg Delay: 0 days" and "Late Filings: —".
            if let s = lag.summary {
                HStack(spacing: 12) {
                    TrendKPI(title: "Median", value: Self.lagDaysText(s.medianLagDays))
                    TrendKPI(title: "90th Pct", value: Self.lagDaysText(s.p90LagDays))
                    TrendKPI(
                        title: "Over 45 Days",
                        value: Self.overLimitText(s.overFortyFivePct),
                        tint: (s.overFortyFivePct ?? 0) > 0 ? .orange : .green
                    )
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

    /// Carries the sample size in the caption so the percentiles are never
    /// naked numbers — `count` is the histogram's denominator.
    private func timelinessCaption(_ s: FilingLagSummary?) -> String {
        let base = "Days from trade to official filing, against the 45-day STOCK Act deadline."
        guard let n = s?.count, n > 0 else { return base }
        return "\(base)  Based on \(CompactFormat.count(n)) disclosures in this window."
    }

    private static func lagDaysText(_ days: Double?) -> String {
        guard let days else { return "—" }
        let rounded = Int(days.rounded())
        return "\(rounded) \(rounded == 1 ? "day" : "days")"
    }

    /// `overFortyFivePct` is a fraction, and the honest values are small
    /// (0.0021 = 0.2%). Rounding to whole percent would print "0%" for a real
    /// handful of late filings, so keep a decimal below 1%.
    private static func overLimitText(_ fraction: Double?) -> String {
        guard let fraction else { return "—" }
        let pct = fraction * 100
        if pct == 0 { return "0%" }
        if pct < 1 { return String(format: "%.1f%%", pct) }
        return String(format: "%.0f%%", pct)
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

/// Signed-money formatting for this tab. `CompactFormat.usd` prints a leading
/// "-" on negatives but nothing on positives, which left the sign of every
/// inflow carried by colour alone — unreadable to anyone colour-blind and
/// invisible in a screenshot (owner: "Net Flow should have a + before it if it
/// is positive and not only rely on green color").
///
/// Deliberately lane-local: this belongs on `CompactFormat` in
/// `Components.swift` next to `usd`, but that file is owned by another lane
/// this wave. Fold it in and delete this enum when the shared helper lands.
private enum TrendsFormat {
    static func signedUsd(_ value: Double?) -> String {
        guard let value else { return "—" }
        // Exactly zero is neither an inflow nor an outflow — signing it would
        // claim a direction the data does not have.
        guard value > 0 else { return CompactFormat.usd(value) }
        return "+\(CompactFormat.usd(value))"
    }
}

private extension String {
    /// Upper-cases only the first character. `.capitalized` would turn
    /// "past 3 months" into "Past 3 Months" — Title Case is for controls and
    /// labels, and this string is a status phrase.
    var capitalizedFirstLetter: String {
        guard let first else { return self }
        return String(first).uppercased() + dropFirst()
    }
}

/// Small legal links pinned under the last card of the tab (owner: "should
/// have small link to privacy policy and other legal docs at bottom of all iOS
/// app tabs").
///
/// Buttons + `openURL` rather than `Link`, and `.buttonStyle(.plain)` on each,
/// because the TabView's `.tint(.blue)` propagates `accentColor` into
/// link/button label styling and overrides a plain `.foregroundStyle` — the
/// same mechanism that kept the toolbar icons stubbornly blue. Underline, not
/// colour, carries the affordance.
struct LegalFooterLinks: View {
    @Environment(\.openURL) private var openURL

    private static let destinations: [(title: String, url: URL)] = [
        ("Privacy Policy", URL(string: "https://Congress.Trade/privacy-policy")!),
        ("Terms of Service", URL(string: "https://Congress.Trade/terms-of-service")!),
        ("Legal", URL(string: "https://Congress.Trade/legal")!),
    ]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(Self.destinations.enumerated()), id: \.element.title) { idx, item in
                if idx > 0 {
                    Text("  •  ")
                        .foregroundStyle(.tertiary)
                }
                Button {
                    openURL(item.url)
                } label: {
                    Text(item.title)
                        .underline()
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isLink)
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, 12)
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

struct ProviderScorecard: View {
    let provider: LatencyProvider
    let minMatched: Int

    var body: some View {
        // Mirror web honesty gates: usable = full claim; preliminary = soft timing.
        // Never paint "tie" when W+L+T is empty or lead seconds are missing (QQ empty-publish bug).
        let status = provider.comparisonStatus ?? "insufficient"
        let usable = status == "usable"
        let preliminary = status == "preliminary"
        let wins = provider.usFirstCount
        let losses = provider.providerFirstCount
        let ties = provider.tieCount
        let deltaSample = wins + losses + ties
        let hasLead = provider.avgLeadSec != nil || provider.medianLeadSec != nil
        let hasTiming = provider.matched >= minMatched && deltaSample > 0 && hasLead
        let hasStats = hasTiming && (usable || preliminary)
        let ahead = hasStats && wins > losses
        let tied = hasStats && wins == losses && deltaSample > 0

        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(provider.label)
                    .font(.subheadline.weight(.bold))
                Spacer()
                if hasStats {
                    if preliminary {
                        Text(ahead ? "Preliminary lead" : (tied ? "Preliminary tie" : (wins < losses ? "Preliminary behind" : "Preliminary")))
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color.orange.opacity(0.15)).foregroundStyle(.orange).clipShape(Capsule())
                    } else if ahead {
                        Text("Ahead").font(.caption2.weight(.bold)).padding(.horizontal, 8).padding(.vertical, 3).background(Color.green.opacity(0.2)).foregroundStyle(.green).clipShape(Capsule())
                    } else if tied {
                        Text("Tied").font(.caption2.weight(.bold)).padding(.horizontal, 8).padding(.vertical, 3).background(Color.gray.opacity(0.2)).foregroundStyle(.secondary).clipShape(Capsule())
                    } else {
                        Text("Behind").font(.caption2.weight(.bold)).padding(.horizontal, 8).padding(.vertical, 3).background(Color.red.opacity(0.2)).foregroundStyle(.red).clipShape(Capsule())
                    }
                } else if provider.matched >= minMatched && !usable {
                    Text("Coverage limited").font(.caption2.weight(.bold)).padding(.horizontal, 8).padding(.vertical, 3).background(Color.orange.opacity(0.15)).foregroundStyle(.orange).clipShape(Capsule())
                } else {
                    Text("Gathering").font(.caption2.weight(.bold)).padding(.horizontal, 8).padding(.vertical, 3).background(Color.gray.opacity(0.2)).foregroundStyle(.secondary).clipShape(Capsule())
                }
            }

            if hasStats {
                let winPct = provider.matched > 0 ? Int(round(100.0 * Double(wins) / Double(provider.matched))) : 0
                // Prefer average lead (matches human mean lead/lag); median is secondary.
                let leadSecs = provider.avgLeadSec ?? provider.medianLeadSec
                HStack {
                    Text(formatLead(leadSecs))
                        .font(.title3.weight(.bold))
                        .foregroundStyle(ahead ? .green : (tied ? .primary : .red))
                    Text(preliminary ? "prelim. avg lead" : "avg lead")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(winPct)% win")
                        .font(.caption.weight(.semibold))
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

    private func formatLead(_ secs: Int?) -> String {
        guard let s = secs else { return "—" }
        let absS = abs(Double(s))
        let sign = s > 0 ? "+" : (s < 0 ? "−" : "")
        if absS < 90 { return "\(sign)\(Int(round(absS)))s" }
        if absS < 5400 { return "\(sign)\(Int(round(absS / 60)))m" }
        if absS < 172800 { return "\(sign)\(String(format: "%.1f", absS / 3600))h" }
        return "\(sign)\(String(format: "%.1f", absS / 86400))d"
    }
}
