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
                        ProgressView("Loading Profile...")
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
                        
                        // Performance
                        if let perf = summary?.performance {
                            DetailSection("Performance vs S&P 500") {
                                HStack(spacing: 12) {
                                    MetricTile(title: "Win Rate", value: perf.winRate != nil ? String(format: "%.0f%%", perf.winRate! * 100) : "N/A")
                                    MetricTile(title: "Avg Excess", value: perf.avgExcess != nil ? String(format: "%+.1f%%", perf.avgExcess! * 100) : "N/A")
                                    MetricTile(title: "Median Return", value: perf.medianReturn != nil ? String(format: "%+.1f%%", perf.medianReturn! * 100) : "N/A")
                                }
                                
                                Text("Based on \(perf.scoredCount) scored trades out of \(perf.tradeCount) total.")
                                    .font(.caption)
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
            .navigationTitle(memberName)
            .inlineNavigationTitle()
            .toolbar {
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
