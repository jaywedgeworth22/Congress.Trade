import SwiftUI
import SwiftData

struct PoliticianDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: CongressTradeStore
    
    let memberId: String
    let memberName: String
    
    @State private var isLoading = true
    @State private var member: ClientTrade.Member?
    @State private var summary: ClientMemberResponse.MemberSummary?
    @State private var trades: [ClientTrade] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if isLoading {
                        // The nav bar carries the entity class ("Politician"),
                        // so the name has to live here while the hero is empty.
                        ProgressView("Loading \(memberName)…")
                            .padding(.top, 40)
                    } else if let error = error {
                        ContentUnavailableView("Error", systemImage: "exclamationmark.triangle", description: Text(error))
                    } else if let member = member {
                        // Header
                        VStack(spacing: 12) {
                            if let photoUrlString = member.photoUrl, let url = URL(string: photoUrlString) {
                                AsyncImage(url: url) { phase in
                                    switch phase {
                                    case .success(let image):
                                        image.resizable().aspectRatio(contentMode: .fill)
                                    case .failure:
                                        Text(member.party?.partyEmoji ?? "🦅").font(.system(size: 40))
                                    case .empty:
                                        ProgressView()
                                    @unknown default:
                                        EmptyView()
                                    }
                                }
                                .frame(width: 80, height: 80)
                                .clipShape(Circle())
                                .overlay(Circle().stroke(AppTheme.borderColor, lineWidth: 1))
                            } else {
                                Text(member.party?.partyEmoji ?? "🦅")
                                    .font(.system(size: 40))
                                    .frame(width: 80, height: 80)
                                    .background(Color(uiColor: .secondarySystemBackground), in: Circle())
                                    .overlay(Circle().stroke(AppTheme.borderColor, lineWidth: 1))
                            }
                            
                            VStack(spacing: 4) {
                                Text(member.name ?? memberName)
                                    .font(.title2.weight(.bold))
                                
                                Text([member.chamber?.capitalized, member.party, member.state].compactMap { $0 }.joined(separator: " · "))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.top, 16)
                        
                        // Performance: dual anchors when backend provides them
                        if let perf = summary?.performance {
                            DetailSection("Performance vs S&P 500") {
                                if let trade = perf.tradeDate, trade.scoredCount > 0 {
                                    performanceLegBlock(
                                        title: "Their timing (approx.)",
                                        leg: trade,
                                        matchesTopPerformers: false
                                    )
                                } else if perf.scoredCount > 0 {
                                    // Legacy flat trade-date payload
                                    HStack(spacing: 12) {
                                        MetricTile(title: "Win Rate", value: perf.winRate != nil ? String(format: "%.0f%%", perf.winRate! * 100) : "N/A")
                                        MetricTile(title: "Avg Excess", value: perf.avgExcess != nil ? String(format: "%+.1f%%", perf.avgExcess! * 100) : "N/A")
                                        MetricTile(title: "Median Return", value: perf.medianReturn != nil ? String(format: "%+.1f%%", perf.medianReturn! * 100) : "N/A")
                                    }
                                    Text("Based on \(perf.scoredCount) scored buys out of \(perf.tradeCount).")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }

                                if let filing = perf.filingDate, filing.scoredCount > 0 {
                                    performanceLegBlock(
                                        title: "If you bought at filing",
                                        leg: filing,
                                        matchesTopPerformers: true
                                    )
                                }

                                Text("Buys only · observational, not portfolio P&L or a forecast.")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
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
            // Nav bar carries the entity CLASS, the hero carries the identity —
            // titling the bar with the member's name restated the hero one line
            // below it (owner, on the same duplication in the ticker sheet).
            .navigationTitle("Politician")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    if let shareURL = store.api.shareURL(queryItem: URLQueryItem(name: "member", value: memberId)) {
                        ShareLink(item: shareURL) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("Share politician")
                    }
                }
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .task {
                await loadProfile()
            }
        }
    }
    
    /// One anchor leg of the buys-only skill aggregate.
    ///
    /// `matchesTopPerformers` marks the FILING-date leg, the only one whose
    /// Avg Excess is the same statistic the Top Performers board ranks and
    /// prints (`GET /member-performance` → `avgExcessReturn`; see the anchor
    /// note in `app/src/analytics/routes.ts`). The annualized figure that used
    /// to be captioned "matches Top Performers" here never did — the backend
    /// keeps `avgAnnualizedExcess` for reference/debugging only, because a
    /// young trade's ~12x annualization multiplier made it misleading as a
    /// headline. It is gone rather than relabelled: the honest number is
    /// already the tile above, so restating it would just be a second copy.
    @ViewBuilder
    private func performanceLegBlock(
        title: String,
        leg: ClientMemberResponse.PerformanceLeg,
        matchesTopPerformers: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            HStack(spacing: 12) {
                MetricTile(
                    title: "Avg Excess",
                    value: leg.avgExcess != nil ? String(format: "%+.1f%%", leg.avgExcess! * 100) : "N/A"
                )
                MetricTile(
                    title: "Win Rate",
                    value: leg.winRate != nil ? String(format: "%.0f%%", leg.winRate! * 100) : "N/A"
                )
                MetricTile(
                    title: "Median Excess",
                    value: leg.medianExcess != nil ? String(format: "%+.1f%%", leg.medianExcess! * 100) : "N/A"
                )
            }
            if matchesTopPerformers, leg.avgExcess != nil {
                Text("Avg Excess is the statistic Top Performers ranks by.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text("\(leg.scoredCount) of \(leg.tradeCount) buys scored")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func loadProfile() async {
        isLoading = true
        error = nil
        do {
            let response = try await store.api.member(id: memberId)
            self.member = response.member
            self.summary = response.summary
            self.trades = response.items
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}
