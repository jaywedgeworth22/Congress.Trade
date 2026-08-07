import SwiftUI

struct TrendsView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @State private var showDisclaimerDetails = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    DisclaimerBanner(isExpanded: $showDisclaimerDetails)

                    // Identical shared filters as Trades (no export, no politician/asset extras).
                    FeedControlBar(showMetrics: false)

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
                .padding(16)
            }
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // No leading placeholder — dead chrome with no action.
                ToolbarItem(placement: .principal) {
                    BrandTitle()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        withAnimation { showDisclaimerDetails.toggle() }
                    } label: {
                        Image(systemName: "info.circle")
                            .foregroundStyle(.blue)
                    }
                    .accessibilityLabel("About Congress.Trade")
                }
            }
            .task {
                if store.analyticsSummary == nil {
                    await store.refreshTrends()
                }
                showDisclaimerDetails = true
                try? await Task.sleep(for: .seconds(4))
                if !Task.isCancelled {
                    withAnimation { showDisclaimerDetails = false }
                }
            }
            .refreshable {
                await store.refreshTrends()
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
                    .padding(.vertical, 8)
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
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                }
            }
        }
    }

    private var sectorAndCapSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            if !store.sectorFlow.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Net Flow by Sector")
                        .font(.headline)
                    VStack(spacing: 0) {
                        ForEach(Array(store.sectorFlow.prefix(8).enumerated()), id: \.element.id) { idx, s in
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
                            if idx < min(7, store.sectorFlow.count - 1) {
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
                    VStack(spacing: 0) {
                        ForEach(Array(store.marketCapBuckets.enumerated()), id: \.element.id) { idx, cap in
                            HStack {
                                Text(cap.bucket.capitalized)
                                    .font(.subheadline.weight(.medium))
                                Spacer()
                                Text("\(cap.tradeCount) trades")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(CompactFormat.usd(cap.estNetFlowUsd))
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle((cap.estNetFlowUsd ?? 0) >= 0 ? .green : .red)
                                    .frame(width: 80, alignment: .trailing)
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

    private var performersSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Top Performers (vs S&P 500)")
                .font(.headline)
            Text("Politicians whose disclosed buys beat the S&P 500 post-filing date.")
                .font(.caption)
                .foregroundStyle(.secondary)

            VStack(spacing: 0) {
                ForEach(Array(store.topPerformers.prefix(8).enumerated()), id: \.element.id) { idx, p in
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
                        if let ret = p.avgAnnualizedExcessReturn {
                            Text(String(format: "%+.1f%% vs SPX", ret * 100))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(ret >= 0 ? .green : .red)
                        }
                    }
                    .padding(.vertical, 8)
                    if idx < min(7, store.topPerformers.count - 1) {
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

    private func timelinessSection(lag: FilingLagResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Disclosure Timeliness")
                .font(.headline)
            Text("Days from trade to official filing date (45-day STOCK Act limit).")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let s = lag.summary {
                HStack(spacing: 12) {
                    TrendKPI(title: "Avg Delay", value: "\(Int(round(s.avgLagDays ?? 0))) days")
                    TrendKPI(title: "Median Delay", value: "\(Int(round(s.medianLagDays ?? 0))) days")
                    TrendKPI(title: "Late Filings", value: CompactFormat.count(s.lateCount), tint: (s.lateCount ?? 0) > 0 ? .orange : .green)
                }
            }

            if let late = lag.topLateFilers, !late.isEmpty {
                Text("Slowest Filers (Avg Delay)")
                    .font(.subheadline.weight(.bold))
                    .padding(.top, 6)
                VStack(spacing: 0) {
                    ForEach(Array(late.prefix(6).enumerated()), id: \.element.id) { idx, f in
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
