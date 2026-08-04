import SwiftUI

struct TrendsView: View {
    @EnvironmentObject private var store: CongressTradeStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    trendsWindowPicker

                    if store.isLoadingTrends && store.analyticsSummary == nil {
                        ProgressView("Loading trends…")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 40)
                    } else {
                        if let notice = store.trendsNotice {
                            NoticeView(message: notice)
                        }

                        summaryStrip

                        if !store.volumeSeries.isEmpty {
                            volumeSection
                        }

                        if !store.tickerLeaderboard.isEmpty {
                            tickerSection
                        }

                        if !store.clusterBuys.isEmpty {
                            clusterSection
                        }

                        if !store.sectorFlow.isEmpty {
                            sectorSection
                        }

                        if !store.memberLeaderboard.isEmpty {
                            memberSection
                        }

                        if let summary = store.latencySummary {
                            LatencyComparisonView(summary: summary)
                        }
                    }
                }
                .padding(16)
            }
            .background(AppTheme.background)
            .navigationTitle("Trends")
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Menu {
                        ForEach(TimeRange.allCases) { range in
                            Button {
                                Task {
                                    await store.setTimeRange(range)
                                    await store.refreshTrends()
                                }
                            } label: {
                                HStack {
                                    Text(range.label)
                                    if store.selectedTimeRange == range {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    } label: {
                        Label(store.selectedTimeRange.label, systemImage: "calendar")
                    }
                }
            }
            .task {
                if store.analyticsSummary == nil {
                    await store.refreshTrends()
                }
            }
            .refreshable {
                await store.refreshTrends()
            }
        }
    }

    private var trendsWindowPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach([TimeRange.thirtyDays, .ninetyDays, .oneYear, .all], id: \.rawValue) { range in
                    FilterChip(
                        title: range == .all ? "All" : range.label.replacingOccurrences(of: "Past ", with: ""),
                        isSelected: store.selectedTimeRange == range
                    ) {
                        Task {
                            await store.setTimeRange(range)
                            await store.refreshTrends()
                        }
                    }
                }
            }
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
                    value: CompactFormat.usd(s?.estimatedNetFlowUsd),
                    tint: (s?.estimatedNetFlowUsd ?? 0) >= 0 ? .green : .red
                )
                TrendKPI(title: "Buys", value: CompactFormat.count(s?.buyCount), tint: .green)
                TrendKPI(title: "Sells", value: CompactFormat.count(s?.sellCount), tint: .red)
            }
        }
    }

    private var volumeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Buys vs Sells")
                .font(.headline)
            Text("Trade counts over the selected window.")
                .font(.caption)
                .foregroundStyle(.secondary)

            let maxCount = max(store.volumeSeries.map { $0.buys + $0.sells }.max() ?? 1, 1)
            VStack(spacing: 6) {
                ForEach(store.volumeSeries.suffix(12)) { point in
                    HStack(spacing: 8) {
                        Text(point.period)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(width: 64, alignment: .leading)
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
            Text("Most-Traded Assets")
                .font(.headline)
            VStack(spacing: 0) {
                ForEach(Array(store.tickerLeaderboard.prefix(12).enumerated()), id: \.element.id) { idx, item in
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
                    .padding(.vertical, 8)
                    if idx < min(11, store.tickerLeaderboard.count - 1) {
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
                            text: c.txType == "P" ? "Buy" : (c.txType == "S" ? "Sell" : c.txType),
                            color: c.txType == "P" ? .green : (c.txType == "S" ? .red : .blue),
                            compact: true
                        )
                        Text("\(c.memberCount) pols")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(10)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                }
            }
        }
    }

    private var sectorSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Net Flow by Sector")
                .font(.headline)
            VStack(spacing: 0) {
                ForEach(Array(store.sectorFlow.prefix(10).enumerated()), id: \.element.id) { idx, s in
                    HStack {
                        Text(s.sector)
                            .font(.subheadline.weight(.medium))
                            .lineLimit(1)
                        Spacer()
                        Text(CompactFormat.usd(s.estNetFlowUsd))
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle((s.estNetFlowUsd ?? 0) >= 0 ? .green : .red)
                    }
                    .padding(.vertical, 8)
                    if idx < min(9, store.sectorFlow.count - 1) {
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
                    if idx < min(9, store.memberLeaderboard.count - 1) {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
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
            Text("Concurrent races only: both feeds first-seen the same trade inside the score window (gap ≤ 48h). Multi-day backfill alignments are excluded from lead stats.")
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
        let status = provider.comparisonStatus ?? "insufficient"
        let usable = status == "usable"
        let preliminary = status == "preliminary"
        let hasStats = provider.matched >= minMatched && (usable || preliminary)
        let wins = provider.usFirstCount
        let losses = provider.providerFirstCount
        let ahead = hasStats && wins > losses
        let tied = hasStats && !ahead && wins == losses

        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(provider.label)
                    .font(.subheadline.weight(.bold))
                Spacer()
                if hasStats {
                    if preliminary {
                        Text(ahead ? "Preliminary lead" : (tied ? "Preliminary tie" : "Preliminary"))
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
                HStack {
                    Text(formatLead(provider.medianLeadSec))
                        .font(.title3.weight(.bold))
                        .foregroundStyle(ahead ? .green : (tied ? .primary : .red))
                    Text(preliminary ? "prelim. concurrent median" : "concurrent median")
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
                    provider.matched > 0
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
        guard let s = secs else { return "0s" }
        let absS = abs(Double(s))
        let sign = s > 0 ? "+" : (s < 0 ? "−" : "")
        if absS < 90 { return "\(sign)\(Int(round(absS)))s" }
        if absS < 5400 { return "\(sign)\(Int(round(absS / 60)))m" }
        if absS < 172800 { return "\(sign)\(String(format: "%.1f", absS / 3600))h" }
        return "\(sign)\(String(format: "%.1f", absS / 86400))d"
    }
}
