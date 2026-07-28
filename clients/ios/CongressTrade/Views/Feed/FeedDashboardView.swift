import SwiftUI
import SwiftData

struct FeedDashboardView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Query private var cachedTrades: [ClientTrade]
    @State private var searchText = ""
    @State private var appliedSearch = ""
    @State private var searchTask: Task<Void, Never>?
    @State private var selectedTrade: ClientTrade?
    @State private var selectedPoliticianId: String?
    @State private var selectedPoliticianName: String?

    /// Newest trade date first; cursor is only a tie-breaker so seed imports of
    /// old filings don't sit above recent activity just because they were
    /// inserted later.
    private var sortedCached: [ClientTrade] {
        cachedTrades.sorted { lhs, rhs in
            let ld = lhs.transaction.date ?? ""
            let rd = rhs.transaction.date ?? ""
            if ld != rd { return ld > rd }
            return lhs.cursor > rhs.cursor
        }
    }

    var filteredTrades: [ClientTrade] {
        let needle = appliedSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let chambers = store.selectedChambers
        let filteringChambers = !chambers.isEmpty
        let fromISO = store.selectedTimeRange.fromDateISO

        return sortedCached.filter { trade in
            if let fromISO {
                let tx = trade.transaction.date ?? ""
                if !tx.isEmpty, tx < fromISO { return false }
            }

            if filteringChambers {
                if let raw = trade.member.chamber?.lowercased(), let chamber = ChamberFilter(rawValue: raw) {
                    if !chambers.contains(chamber) { return false }
                } else {
                    // Unresolved chamber drops out only when a filter is active.
                    return false
                }
            }

            if !needle.isEmpty {
                return TradeSearch.matches(trade, normalizedNeedle: needle)
            }
            return true
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    FeedControlBar()

                    SearchField(text: $searchText)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(ChamberFilter.allCases) { chamber in
                                FilterChip(
                                    title: chamber.shortLabel,
                                    isSelected: store.selectedChambers.contains(chamber)
                                ) {
                                    toggleChamber(chamber)
                                }
                            }
                        }
                    }

                    if let notice = store.feedNotice, store.isOffline || !notice.isEmpty {
                        FeedFreshnessView(
                            isOffline: store.isOffline,
                            lastRefresh: store.lastSuccessfulRefresh,
                            notice: store.feedNotice,
                            onRetry: { Task { await store.refresh() } }
                        )
                    }

                    if filteredTrades.isEmpty && !store.isRefreshing {
                        ContentUnavailableView {
                            Label(
                                appliedSearch.isEmpty ? "No Trades in Range" : "No Matching Trades",
                                systemImage: "tray"
                            )
                        } description: {
                            Text(
                                appliedSearch.isEmpty
                                    ? "Try a wider time range, or pull to refresh."
                                    : "Try another ticker, politician, or state."
                            )
                        } actions: {
                            Button("Retry") { Task { await store.refresh() } }
                                .buttonStyle(.bordered)
                                .clipShape(Capsule())
                        }
                        .padding(.top, 40)
                    }

                    LazyVStack(spacing: 8) {
                        ForEach(filteredTrades) { trade in
                            Button {
                                selectedTrade = trade
                            } label: {
                                TradeCard(trade: trade, onPoliticianTap: {
                                    if let memberId = trade.member.id {
                                        selectedPoliticianName = trade.member.name
                                        selectedPoliticianId = memberId
                                    }
                                })
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Opens trade details")
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    BrandTitle()
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Picker("Timeframe", selection: Binding(
                            get: { store.selectedTimeRange },
                            set: { newValue in Task { await store.setTimeRange(newValue) } }
                        )) {
                            ForEach(TimeRange.allCases) { range in
                                Text(range.label).tag(range)
                            }
                        }
                    } label: {
                        Label(store.selectedTimeRange.label, systemImage: "calendar")
                    }
                }
            }
            .refreshable { await store.refresh() }
            .overlay {
                if store.isRefreshing && cachedTrades.isEmpty {
                    ProgressView()
                        .controlSize(.large)
                        .padding(24)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
            .sheet(item: $selectedTrade) { trade in
                TradeDetailView(trade: trade)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(18)
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
            .onChange(of: searchText) { _, newValue in
                searchTask?.cancel()
                searchTask = Task {
                    try? await Task.sleep(for: .milliseconds(180))
                    guard !Task.isCancelled else { return }
                    appliedSearch = newValue
                }
            }
            .onDisappear { searchTask?.cancel() }
        }
    }

    private func toggleChamber(_ chamber: ChamberFilter) {
        var next = store.selectedChambers
        if next.contains(chamber) {
            next.remove(chamber)
        } else {
            next.insert(chamber)
        }
        Task { await store.setChamberSelection(next) }
    }
}

// MARK: - Header / controls

struct BrandTitle: View {
    var body: some View {
        HStack(spacing: 8) {
            // Settle target for EagleSplashView (~32pt).
            Image("BrandLogo")
                .resizable()
                .scaledToFit()
                .frame(width: 32, height: 32)
            Text("Congress.Trade")
                .font(.custom("ZillaSlab-Bold", size: 18, relativeTo: .headline))
                .foregroundStyle(.primary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Congress.Trade")
    }
}

struct FeedControlBar: View {
    @EnvironmentObject private var store: CongressTradeStore

    var body: some View {
        HStack(spacing: 10) {
            Spacer()

            MetricTile(
                title: "Trades",
                value: store.tradeTotal > 0
                    ? store.tradeTotal.formatted(.number.grouping(.automatic))
                    : "—"
            )
            .frame(width: 96)

            MetricTile(title: "Plan", value: store.entitlementLabel)
                .frame(width: 84)
        }
    }
}

struct FilterChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .foregroundStyle(isSelected ? .white : .primary)
                .background(
                    isSelected ? Color.blue : Color(uiColor: .secondarySystemBackground),
                    in: Capsule()
                )
                .overlay(Capsule().stroke(AppTheme.borderColor, lineWidth: 1))
        }
    }
}

struct SearchField: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search ticker, politician, or state", text: $text)
                .neverAutocapitalized()
                .autocorrectionDisabled()
            if !text.isEmpty {
                Button {
                    withAnimation { text = "" }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Clear Search")
            }
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(AppTheme.border(cornerRadius: 12))
    }
}

// MARK: - Compact trade row

struct TradeCard: View {
    let trade: ClientTrade
    var onPoliticianTap: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            AssetMark(symbol: assetTitle, isTicker: trade.asset.ticker != nil, size: 40)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(assetTitle)
                        .font(.subheadline.weight(.bold))
                        .lineLimit(1)
                    StatusPill(
                        text: shortTypeLabel,
                        color: trade.transaction.type.tint,
                        compact: true
                    )
                }

                Button {
                    onPoliticianTap?()
                } label: {
                    Text(politicianLine)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .multilineTextAlignment(.leading)
                }
                .buttonStyle(.plain)
                .disabled(onPoliticianTap == nil)
            }

            Spacer(minLength: 4)

            VStack(alignment: .trailing, spacing: 2) {
                Text(trade.amountLabel)
                    .font(.subheadline.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(trade.transaction.date.shortDate)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppTheme.borderColor.opacity(0.55), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
    }

    private var assetTitle: String {
        trade.asset.ticker ?? trade.asset.type ?? "Asset"
    }

    private var shortTypeLabel: String {
        switch trade.transaction.type {
        case "P": return "Buy"
        case "S": return "Sell"
        case "E": return "Exch"
        default: return trade.transaction.type
        }
    }

    /// Single meta line: "Sen. Name · D-CA" — chamber once, never duplicated.
    private var politicianLine: String {
        let name = trade.member.name ?? "Unknown"
        let chamber = trade.member.chamber?.chamberLabel
        let party = partyLetter(trade.member.party)
        let state = trade.member.state?.uppercased()
        let partyState: String? = {
            switch (party, state) {
            case let (p?, s?): return "\(p)-\(s)"
            case let (p?, nil): return p
            case let (nil, s?): return s
            default: return nil
            }
        }()

        var parts: [String] = []
        if let chamber {
            parts.append("\(chamber) · \(name)")
        } else {
            parts.append(name)
        }
        if let partyState {
            parts.append(partyState)
        }
        return parts.joined(separator: " · ")
    }

    private func partyLetter(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        switch raw.lowercased() {
        case "democrat", "dem", "d": return "D"
        case "republican", "rep", "r": return "R"
        case "independent", "ind", "i": return "I"
        default: return String(raw.prefix(1)).uppercased()
        }
    }
}
