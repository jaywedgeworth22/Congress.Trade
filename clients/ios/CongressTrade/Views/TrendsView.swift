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
                VStack(alignment: .leading, spacing: 16) {
                    DisclaimerBanner(isExpanded: $disclaimerExpanded)

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
                    }
                }
                // Same horizontal/top/bottom insets as Trades so the
                // disclaimer banner lands at an identical position/size on
                // both tabs (owner punch list item 2a — was `.padding(16)`
                // uniformly, 8pt further from the nav bar than Trades).
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            // STICKY FILTERS. Every number on this tab is scoped by the window
            // / branch / party chips, so scrolling them off screen was the
            // fastest way to misread a section. A top safe-area inset pins the
            // bar and lets content slide *under* it — a plain row inside the
            // ScrollView scrolls away, and a row above it eats layout height
            // and leaves a dead gap. Owner chose sticky-bar-only over
            // per-section timeframe labels; that is safe because
            // `refreshTrends()` hands the SAME `analyticsWindow` to every
            // analytics call, so one bar honestly describes the whole tab.
            .safeAreaInset(edge: .top, spacing: 0) {
                FeedControlBar(showMetrics: false)
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 6)
                    .background(.bar)
                    .overlay(alignment: .bottom) { Divider() }
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



    private var summaryStrip: some View {
        let s = store.analyticsSummary
        return VStack(alignment: .leading, spacing: 10) {
            Text("Market Snapshot")
                .font(.headline)
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

    private var sectorAndCapSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            if !store.sectorFlow.isEmpty {
                let rows = SectorFlowRow.rows(from: store.sectorFlow, topCount: 8)
                VStack(alignment: .leading, spacing: 10) {
                    Text("Net Flow by Sector")
                        .font(.headline)
                    Text("Sectors come from ticker enrichment — trades without a resolved ticker aren't included.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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

            if !store.marketCapBuckets.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("By Market Cap")
                        .font(.headline)
                    // Column geometry is a verbatim owner ask: narrow the
                    // cap-size name, widen the far-right money column, and keep
                    // BOTH numeric columns right-aligned so the eye reads one
                    // straight edge of digits. The old 80pt money column
                    // truncated a signed 8-character value like "+$15.7m".
                    VStack(spacing: 0) {
                        ForEach(Array(store.marketCapBuckets.enumerated()), id: \.element.id) { idx, cap in
                            HStack(spacing: 8) {
                                Text(cap.bucket.capitalized)
                                    .font(.subheadline.weight(.medium))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                                    .frame(maxWidth: 92, alignment: .leading)
                                Spacer(minLength: 4)
                                Text("\(cap.tradeCount) trades")
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
                            if idx < store.marketCapBuckets.count - 1 {
                                Divider()
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }
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
    private static let performersMinBuys = 5

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
            Text("Top Performers")
                .font(.headline)
            // Benchmark named ONCE here instead of stamped on every row.
            // Wording mirrors the `note` field this endpoint returns
            // (`app/src/analytics/routes.ts`); iOS only decodes `members`, so
            // if that note is ever reworded, reword this too.
            Text("Average excess return vs S&P 500 on disclosed buys, measured from each filing date — what a follower could actually have acted on.  Each trade is capped at ±200% so one outlier can't carry a politician.  Buys only, options excluded.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("\(store.selectedTimeRange.label)  •  minimum \(Self.performersMinBuys) buys")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)

            VStack(spacing: 0) {
                ForEach(Array(ranked.enumerated()), id: \.element.id) { idx, p in
                    Button {
                        selectedPoliticianId = p.filerId
                        selectedPoliticianName = p.fullName ?? p.filerId
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
                    .accessibilityLabel("\(p.fullName ?? p.filerId), \(p.tradeCount) buys, \(SignedPercentFormat.percent(p.avgExcessReturn)) vs S&P 500")
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
                    Text("9 in 10 filings land inside the P90 figure.  Based on \(CompactFormat.count(count)) disclosed trades in this window.")
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
private struct SectorFlowRow: Identifiable {
    let id: String
    let label: String
    let estNetFlowUsd: Double?
    /// Aggregate rows (Other / Unknown) are de-emphasised — they name a bucket,
    /// not a sector anyone chose to trade.
    let isAggregate: Bool

    static func rows(from sectors: [SectorFlowItem], topCount: Int) -> [SectorFlowRow] {
        // "Unknown" is pulled out BEFORE ranking. Leaving it in would let a
        // data-quality bucket win a top-8 slot from a real sector.
        let unknown = sectors.filter { $0.sector.caseInsensitiveCompare("Unknown") == .orderedSame }
        let named = sectors.filter { $0.sector.caseInsensitiveCompare("Unknown") != .orderedSame }

        var out = named.prefix(topCount).map {
            SectorFlowRow(id: $0.sector, label: $0.sector, estNetFlowUsd: $0.estNetFlowUsd, isAggregate: false)
        }

        let rest = named.dropFirst(topCount)
        if !rest.isEmpty {
            // Sum only the sectors that reported a figure; if none did, stay an
            // em-dash rather than claiming a $0 net.
            let scored = rest.compactMap(\.estNetFlowUsd)
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
            let scored = unknown.compactMap(\.estNetFlowUsd)
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
