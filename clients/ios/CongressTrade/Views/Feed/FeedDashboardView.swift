import SwiftUI
import SwiftData

struct FeedDashboardView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Query(sort: \ClientTrade.cursor, order: .reverse) private var cachedTrades: [ClientTrade]
    @State private var searchText = ""
    @State private var appliedSearch = ""
    @State private var searchTask: Task<Void, Never>?
    @State private var selectedTrade: ClientTrade?

    var filteredTrades: [ClientTrade] {
        let needle = appliedSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let chambers = store.selectedChambers
        // A selection identical to the backend's true default also keeps rows
        // whose chamber could not be resolved (matches the server's absent-
        // `chamber` clause); any explicit narrower/wider selection is an
        // exact IN-list and drops unresolved rows, same as the request sent.
        let matchesDefaultSelection = chambers == CongressTradeStore.defaultChambers

        return cachedTrades.filter { trade in
            if let raw = trade.member.chamber?.lowercased(), let chamber = ChamberFilter(rawValue: raw) {
                if !chambers.contains(chamber) { return false }
            } else if !matchesDefaultSelection {
                return false
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
                VStack(spacing: 14) {
                    HeaderSummary(
                        tradeCount: cachedTrades.count,
                        cursor: cachedTrades.first?.cursor ?? 0,
                        signedIn: store.signedIn,
                        entitlementLabel: store.entitlementLabel
                    )

                    SearchField(text: $searchText)
                    
                    // Filter Chips — the same selection drives the feed request (CT-AUD-010).
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(ChamberFilter.allCases) { chamber in
                                FilterChip(
                                    title: chamber.label,
                                    isSelected: store.selectedChambers.contains(chamber)
                                ) {
                                    toggleChamber(chamber)
                                }
                            }
                        }
                    }

                    FeedFreshnessView(
                        isOffline: store.isOffline,
                        lastRefresh: store.lastSuccessfulRefresh,
                        notice: store.feedNotice,
                        onRetry: { Task { await store.refresh() } }
                    )

                    if filteredTrades.isEmpty && !store.isRefreshing {
                        ContentUnavailableView {
                            Label(
                                appliedSearch.isEmpty ? "No Saved Trades" : "No Matching Trades",
                                systemImage: "tray"
                            )
                        } description: {
                            Text(appliedSearch.isEmpty ? "Refresh to load the latest disclosures." : "Try another ticker, politician, or state.")
                        } actions: {
                            Button("Retry") { Task { await store.refresh() } }
                                .buttonStyle(.bordered)
                                .clipShape(Capsule())
                        }
                    }

                    LazyVStack(spacing: 12) {
                        ForEach(filteredTrades) { trade in
                            Button {
                                selectedTrade = trade
                            } label: {
                                TradeCard(trade: trade)
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Opens trade details")
                            // Smooth list animation
                            .transition(.opacity.combined(with: .scale(scale: 0.98)))
                        }
                    }
                    .animation(.spring(response: 0.3, dampingFraction: 0.7), value: filteredTrades)
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle("Congress.Trade")
            .refreshable { await store.refresh() }
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button {
                        Task { await store.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .fontWeight(.semibold)
                    }
                    .accessibilityLabel("Refresh")
                }
            }
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
            }
            .onChange(of: searchText) { _, newValue in
                searchTask?.cancel()
                searchTask = Task {
                    try? await Task.sleep(for: .milliseconds(180))
                    guard !Task.isCancelled else { return }
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                        appliedSearch = newValue
                    }
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
        // setChamberSelection resets an empty selection back to the documented
        // default and resyncs the feed against the new selection (CT-AUD-010).
        Task { await store.setChamberSelection(next) }
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
                    isSelected ? Color.blue : Color.white.opacity(0.1),
                    in: Capsule()
                )
                .overlay(Capsule().stroke(Color.white.opacity(0.1), lineWidth: 1))
        }
    }
}

struct HeaderSummary: View {
    let tradeCount: Int
    let cursor: Int
    let signedIn: Bool
    let entitlementLabel: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Live Control Surface")
                        .font(.caption.weight(.bold))
                        .textCase(.uppercase)
                        .foregroundStyle(.blue.opacity(0.8))
                    Text("Fast Congressional trade monitoring")
                        .font(.title3.weight(.bold))
                }
                Spacer()
                StatusPill(text: signedIn ? "Signed In" : "Guest", color: signedIn ? .green : .orange)
            }

            HStack(spacing: 8) {
                MetricTile(title: "Trades", value: "\(tradeCount)")
                MetricTile(title: "Cursor", value: "\(cursor)")
                MetricTile(title: "Plan", value: entitlementLabel)
            }
        }
        .padding(16)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 16))
        .overlay(AppTheme.border)
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
        .overlay(AppTheme.border)
    }
}

struct TradeCard: View {
    let trade: ClientTrade

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                AssetMark(symbol: assetTitle)
                VStack(alignment: .leading, spacing: 2) {
                    Text(assetTitle)
                        .font(.headline)
                        .lineLimit(1)
                    Text(trade.asset.name)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                StatusPill(
                    text: trade.transaction.type.label,
                    color: trade.transaction.type.tint,
                    icon: trade.transaction.type == "P" ? "arrow.down.right.circle.fill" : (trade.transaction.type == "S" ? "arrow.up.right.circle.fill" : "arrow.left.and.right.circle.fill")
                )
            }

            Divider().background(Color.white.opacity(0.1))

            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 4) {
                        Text(trade.member.party?.partyEmoji ?? "")
                            .font(.subheadline)
                        Text(trade.member.name ?? "Unknown Politician")
                            .font(.body.weight(.bold))
                    }
                    Text(memberMeta)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text(trade.amountLabel)
                        .font(.title3.weight(.heavy))
                        .foregroundStyle(trade.transaction.type == "P" ? .green : .primary)
                    Text(trade.source == .primary ? "Live Read" : "Historical")
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(trade.source == .primary ? Color.blue.opacity(0.2) : Color.gray.opacity(0.2), in: Capsule())
                        .foregroundStyle(trade.source == .primary ? .blue : .secondary)
                }
            }

            HStack(spacing: 8) {
                DateChip(title: "Traded", value: trade.transaction.date.shortDate, icon: "calendar")
                DateChip(title: "Filed", value: trade.filing.filedDate.shortDate, icon: "doc.text")
            }
        }
        .padding(16)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .background(chamberGradient.opacity(0.05), in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.white.opacity(0.15), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.2), radius: 8, x: 0, y: 4)
    }

    private var assetTitle: String {
        trade.asset.ticker ?? trade.asset.type ?? "Asset"
    }

    private var memberMeta: String {
        [trade.member.chamber?.chamberLabel, trade.member.state, trade.member.party]
            .compactMap { value in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .joined(separator: " · ")
    }
    
    private var chamberGradient: Color {
        let chamber = trade.member.chamber?.lowercased() ?? ""
        if chamber == "house" { return AppTheme.houseColor }
        if chamber == "senate" { return AppTheme.senateColor }
        if chamber == "executive" { return AppTheme.execColor }
        return AppTheme.panel
    }
}
