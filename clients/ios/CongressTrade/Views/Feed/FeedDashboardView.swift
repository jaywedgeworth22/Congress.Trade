import SwiftUI
import SwiftData
import UIKit

enum TradeFilterField: Hashable {
    case politician, asset
}

struct FeedDashboardView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Query private var cachedTrades: [ClientTrade]
    @State private var politicianText = ""
    @State private var assetText = ""
    @State private var filterTask: Task<Void, Never>?
    @State private var selectedTrade: ClientTrade?
    @State private var selectedPoliticianId: String?
    @State private var selectedPoliticianName: String?
    @State private var selectedTicker: String?
    @State private var showDisclaimerDetails = false
    @State private var showExportSheet = false
    @FocusState private var focusedField: TradeFilterField?

    /// Newest trade date first; cursor is only a tie-breaker so seed imports of
    /// old filings don't sit above recent activity just because they were
    /// inserted later.
    private var sortedCached: [ClientTrade] {
        cachedTrades.sorted { lhs, rhs in
            let ld = lhs.transaction.date ?? ""
            let rd = rhs.transaction.date ?? ""
            if ld != rd { return ld > rd }
            let lf = lhs.filing.filedDate ?? ""
            let rf = rhs.filing.filedDate ?? ""
            if lf != rf { return lf > rf }
            return (lhs.cursor ?? 0) > (rhs.cursor ?? 0)
        }
    }

    var filteredTrades: [ClientTrade] {
        let politicianNeedle = politicianText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let assetNeedle = assetText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let chambers = store.selectedChambers
        let filteringChambers = !chambers.isEmpty
        let fromISO = store.selectedTimeRange.fromDateISO
        let toISO = store.selectedTimeRange.toDateISO
        let typeFilter = store.selectedTradeType

        return sortedCached.filter { trade in
            if let fromISO {
                let tx = trade.transaction.date ?? ""
                if !tx.isEmpty, tx < fromISO { return false }
            }
            if let toISO {
                let tx = trade.transaction.date ?? ""
                if !tx.isEmpty, tx > toISO { return false }
            }

            if filteringChambers {
                if let raw = trade.member.chamber?.lowercased(), let chamber = ChamberFilter(rawValue: raw) {
                    if !chambers.contains(chamber) { return false }
                } else {
                    // Unresolved chamber drops out only when a filter is active.
                    return false
                }
            }

            if !typeFilter.matches(txType: trade.transaction.type) {
                return false
            }

            if !politicianNeedle.isEmpty {
                let name = (trade.member.name ?? "").lowercased()
                let state = (trade.member.state ?? "").lowercased()
                if !name.contains(politicianNeedle) && !state.contains(politicianNeedle) {
                    return false
                }
            }

            if !assetNeedle.isEmpty {
                let ticker = (trade.asset.ticker ?? "").lowercased()
                let name = (trade.asset.name ?? "").lowercased()
                if !ticker.contains(assetNeedle) && !name.contains(assetNeedle) {
                    return false
                }
            }
            return true
        }
    }

    private var hasActiveTextFilter: Bool {
        !politicianText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !assetText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    DisclaimerBanner(isExpanded: $showDisclaimerDetails)

                    // Shared filters (also on Trends) — chamber / party / sides / timeframe.
                    FeedControlBar()

                    // Trades-only extras: politician, asset, type is already in shared bar as Sides.
                    TradesExtraFilters(
                        politicianText: $politicianText,
                        assetText: $assetText,
                        focusedField: $focusedField,
                        onPoliticianSubmit: {
                            Task { await store.setPoliticianFilter(politicianText) }
                        },
                        onAssetSubmit: {
                            Task { await store.setAssetFilter(assetText) }
                        },
                        onPoliticianClear: {
                            Task { await store.setPoliticianFilter("") }
                        },
                        onAssetClear: {
                            Task { await store.setAssetFilter("") }
                        }
                    )

                    HStack {
                        Spacer(minLength: 0)
                        Text("\(filteredTrades.count) trades")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }

                    // Only real offline/error notices — never cancellation noise.
                    if let notice = store.feedNotice,
                       store.isOffline || (!notice.isEmpty && !Self.isBenignCancellationNotice(notice)) {
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
                                hasActiveTextFilter ? "No Matching Trades" : "No Trades in Range",
                                systemImage: "tray"
                            )
                        } description: {
                            Text(
                                hasActiveTextFilter
                                    ? "Try another ticker, politician, or state."
                                    : "Try a wider time range, or pull to refresh."
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
                                }, onTickerTap: trade.asset.ticker.map { ticker in
                                    { selectedTicker = ticker }
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
            .scrollDismissesKeyboard(.interactively)
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showExportSheet = true
                    } label: {
                        Image(systemName: "arrow.down.circle")
                            .foregroundStyle(.primary)
                    }
                    .accessibilityLabel("Export CSV")
                }
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
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focusedField = nil }
                }
            }
            .refreshable { await store.refresh() }
            .task {
                showDisclaimerDetails = true
                try? await Task.sleep(for: .seconds(4))
                if !Task.isCancelled {
                    withAnimation { showDisclaimerDetails = false }
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
            .sheet(isPresented: $showExportSheet) {
                ExportCSVSheet()
                    .environmentObject(store)
                    .presentationDetents([.medium])
                    .presentationDragIndicator(.visible)
            }
            .onChange(of: politicianText) { _, newValue in
                scheduleFilterApply {
                    await store.setPoliticianFilter(newValue)
                }
            }
            .onChange(of: assetText) { _, newValue in
                scheduleFilterApply {
                    await store.setAssetFilter(newValue)
                }
            }
            .onDisappear { filterTask?.cancel() }
            .onAppear {
                politicianText = store.politicianFilter
                assetText = store.assetFilter
            }
            .simultaneousGesture(
                TapGesture().onEnded { focusedField = nil }
            )
        }
    }

    private func scheduleFilterApply(_ work: @escaping @MainActor () async -> Void) {
        filterTask?.cancel()
        filterTask = Task {
            try? await Task.sleep(for: .milliseconds(320))
            guard !Task.isCancelled else { return }
            await work()
        }
    }

    /// Grey full-width "cancelled" cards under the filter bar came from
    /// URLError.cancelled / Task cancel being painted as feedNotice.
    private static func isBenignCancellationNotice(_ message: String) -> Bool {
        let lower = message.lowercased()
        return lower == "cancelled" || lower == "canceled" || lower.contains("cancelled") || lower.contains("canceled")
    }
}

// MARK: - Header / controls

/// Website-parity brand lockup: eagle+bag with CONGRESS / TRADE baked into the
/// light/dark lockup assets. No trailing "Congress.Trade" text after the mark.
/// Sized ~50% larger than the old 28pt bar so it matches the height of the
/// side toolbar buttons and uses the sticky nav chrome instead of empty padding.
struct BrandTitle: View {
    var body: some View {
        Image("BrandLockup")
            .resizable()
            .scaledToFit()
            .frame(height: 42)
            .frame(maxWidth: 300)
            .accessibilityLabel("Congress.Trade")
    }
}

/// Shared under-header filter strip used on both Trades and Trends.
struct FeedControlBar: View {
    @EnvironmentObject private var store: CongressTradeStore
    var showMetrics: Bool = true

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                // Branch/Chamber Filter
                Menu {
                    Button("All Branches") {
                        Task { await store.setChamberSelection([]) }
                    }
                    ForEach(ChamberFilter.allCases) { chamber in
                        Button {
                            toggleChamber(chamber)
                        } label: {
                            HStack {
                                Text(chamber.label)
                                if store.selectedChambers.contains(chamber) {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    FilterMenuLabel(
                        title: store.selectedChambers.isEmpty ? "All Branches" : store.selectedChambers.map { $0.shortLabel }.joined(separator: ", "),
                        icon: "building.columns",
                        isActive: !store.selectedChambers.isEmpty
                    )
                }

                // Party Filter
                Menu {
                    Button("All Parties") {
                        Task { await store.setPartyFilter(nil) }
                    }
                    ForEach(PartyFilter.allCases) { party in
                        Button {
                            Task { await store.setPartyFilter(party) }
                        } label: {
                            HStack {
                                Text("\(party.emoji) \(party.label)")
                                if store.selectedParty == party {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    FilterMenuLabel(
                        title: store.selectedParty?.label ?? "All Parties",
                        icon: "person.2.fill",
                        isActive: store.selectedParty != nil
                    )
                }

                // Side Filter (Buy/Sell) — green up + red down instead of double-arrow.
                Menu {
                    ForEach(TradeTypeFilter.allCases) { type in
                        Button {
                            Task { await store.setTradeType(type) }
                        } label: {
                            HStack {
                                Text(type.label)
                                if store.selectedTradeType == type {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    SidesFilterMenuLabel(
                        title: store.selectedTradeType.label,
                        isActive: store.selectedTradeType != .all,
                        selected: store.selectedTradeType
                    )
                }

                // Timeframe Filter
                Menu {
                    ForEach(TimeRange.allCases) { range in
                        Button {
                            Task { await store.setTimeRange(range) }
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
                    FilterMenuLabel(
                        title: store.selectedTimeRange.label,
                        icon: "calendar",
                        isActive: store.selectedTimeRange != .ninetyDays
                    )
                }
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 4)
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

/// Tiny green up + red down arrows for the shared Sides control.
struct SidesFilterMenuLabel: View {
    let title: String
    let isActive: Bool
    let selected: TradeTypeFilter

    var body: some View {
        HStack(spacing: 4) {
            HStack(spacing: 1) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 9, weight: .heavy))
                    .foregroundStyle(selected == .sell ? (isActive ? .white : .secondary) : Color.green)
                Image(systemName: "arrow.down")
                    .font(.system(size: 9, weight: .heavy))
                    .foregroundStyle(selected == .buy ? (isActive ? .white : .secondary) : Color.red)
            }
            Text(title)
                .font(.caption.weight(.semibold))
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .bold))
                .opacity(0.5)
                .padding(.leading, 2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .foregroundStyle(isActive ? .white : .primary)
        .background(
            isActive ? Color.blue : Color(uiColor: .secondarySystemBackground),
            in: Capsule()
        )
        .overlay(Capsule().stroke(AppTheme.borderColor, lineWidth: 1))
    }
}

struct FilterMenuLabel: View {
    let title: String
    let icon: String
    let isActive: Bool

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption.weight(.bold))
            Text(title)
                .font(.caption.weight(.semibold))
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .bold))
                .opacity(0.5)
                .padding(.leading, 2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .foregroundStyle(isActive ? .white : .primary)
        .background(
            isActive ? Color.blue : Color(uiColor: .secondarySystemBackground),
            in: Capsule()
        )
        .overlay(Capsule().stroke(AppTheme.borderColor, lineWidth: 1))
    }
}

/// Trades-only politician + asset fields under the shared filter bar.
struct TradesExtraFilters: View {
    @Binding var politicianText: String
    @Binding var assetText: String
    var focusedField: FocusState<TradeFilterField?>.Binding
    var onPoliticianSubmit: () -> Void
    var onAssetSubmit: () -> Void
    var onPoliticianClear: () -> Void
    var onAssetClear: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            CompactFilterField(
                text: $politicianText,
                placeholder: "Politician…",
                systemImage: "person",
                focused: focusedField,
                field: .politician,
                onSubmit: onPoliticianSubmit,
                onClear: onPoliticianClear
            )
            CompactFilterField(
                text: $assetText,
                placeholder: "Asset / ticker…",
                systemImage: "chart.bar",
                focused: focusedField,
                field: .asset,
                autocap: true,
                onSubmit: onAssetSubmit,
                onClear: onAssetClear
            )
        }
    }
}

struct CompactFilterField: View {
    @Binding var text: String
    let placeholder: String
    let systemImage: String
    var focused: FocusState<TradeFilterField?>.Binding
    let field: TradeFilterField
    var autocap: Bool = false
    var onSubmit: () -> Void = {}
    var onClear: () -> Void = {}

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Group {
                if autocap {
                    TextField(placeholder, text: $text)
                        .tickerAutocapitalized()
                } else {
                    TextField(placeholder, text: $text)
                        .neverAutocapitalized()
                }
            }
            .font(.subheadline)
            .autocorrectionDisabled()
            .focused(focused, equals: field)
            .submitLabel(.search)
            .onSubmit(onSubmit)
            if !text.isEmpty {
                Button {
                    withAnimation { text = "" }
                    onClear()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(AppTheme.border(cornerRadius: 12))
    }
}

struct SearchField: View {
    @Binding var text: String
    var onSubmit: () -> Void = {}
    var onClear: () -> Void = {}
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search ticker, politician, or state", text: $text)
                .neverAutocapitalized()
                .autocorrectionDisabled()
                .focused($isFocused)
                .submitLabel(.search)
                .onSubmit {
                    onSubmit()
                    isFocused = false
                }
            if !text.isEmpty {
                Button {
                    withAnimation { text = "" }
                    onClear()
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

/// Shared educational disclaimer used on Trades and Trends.
struct DisclaimerBanner: View {
    @Binding var isExpanded: Bool

    var body: some View {
        if isExpanded {
            Text("Congress.Trade is an informational tool for exploring public STOCK Act disclosures. Summaries are historical observational views — not trading signals or investment advice. Dollar figures are estimates from disclosed amount brackets.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// Trades-only export popup: From / To dates + small ↓ CSV (Premium-gated).
struct ExportCSVSheet: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @State private var fromDate = Calendar.current.date(byAdding: .month, value: -3, to: Date()) ?? Date()
    @State private var toDate = Date()
    @State private var isExporting = false
    @State private var notice: String?
    @State private var shareURL: URL?
    @State private var showSubscribe = false

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("From", selection: $fromDate, displayedComponents: .date)
                    DatePicker("To", selection: $toDate, displayedComponents: .date)
                } header: {
                    Text("Date range")
                } footer: {
                    Text("Exports the filtered feed for this range. Premium required.")
                }

                if let notice {
                    Section {
                        Text(notice)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    if !store.signedIn {
                        Text("Sign in with a Premium account to export CSV.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else if !store.isPremium {
                        Text("CSV export is a Premium feature ($5/mo or $50/yr, 1-month free trial).")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Button {
                            showSubscribe = true
                        } label: {
                            Label("Subscribe with Apple", systemImage: "apple.logo")
                        }
                    } else {
                        Button {
                            Task { await runExport() }
                        } label: {
                            if isExporting {
                                ProgressView()
                                    .frame(maxWidth: .infinity)
                            } else {
                                Text("↓ CSV")
                                    .font(.caption.weight(.bold))
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .disabled(isExporting)
                    }
                }
            }
            .navigationTitle("Export")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .sheet(isPresented: $showSubscribe) {
                SubscribeView()
                    .environmentObject(store)
            }
            .sheet(isPresented: Binding(
                get: { shareURL != nil },
                set: { if !$0 { shareURL = nil } }
            )) {
                if let shareURL {
                    ShareSheet(items: [shareURL])
                }
            }
        }
    }

    private func runExport() async {
        isExporting = true
        notice = nil
        defer { isExporting = false }
        let from = Self.dayFormatter.string(from: min(fromDate, toDate))
        let to = Self.dayFormatter.string(from: max(fromDate, toDate))
        do {
            let data = try await store.exportCSV(from: from, to: to)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("congress-trades-\(from)-\(to).csv")
            try data.write(to: url, options: .atomic)
            shareURL = url
            notice = "Ready to share."
        } catch {
            notice = error.localizedDescription
        }
    }
}

/// UIKit share sheet bridge for the exported CSV file URL.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Compact trade row

struct TradeCard: View {
    let trade: ClientTrade
    var onPoliticianTap: (() -> Void)? = nil
    var onTickerTap: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Button {
                onTickerTap?()
            } label: {
                AssetMark(symbol: assetTitle, isTicker: trade.asset.ticker != nil, size: 40)
            }
            .buttonStyle(.plain)
            .disabled(onTickerTap == nil)
            .accessibilityLabel(onTickerTap == nil ? assetTitle : "View \(assetTitle) trades")

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
        trade.asset.displayName
    }

    private var shortTypeLabel: String {
        switch trade.transaction.type {
        case "B", "P": return "Buy"
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
