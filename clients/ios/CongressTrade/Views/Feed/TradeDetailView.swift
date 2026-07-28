import SwiftUI

struct TradeDetailView: View {
    let trade: ClientTrade
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var didCheckRetraction = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Hero Header
                    VStack(alignment: .center, spacing: 12) {
                        AssetMark(symbol: trade.asset.ticker ?? trade.asset.type ?? "A", isTicker: trade.asset.ticker != nil)
                            .scaleEffect(1.3)
                            .padding(.bottom, 8)
                        
                        Text(trade.asset.ticker ?? "Asset")
                            .font(.largeTitle.weight(.heavy))
                        
                        Text(trade.asset.name)
                            .font(.title3.weight(.medium))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        
                        StatusPill(
                            text: trade.transaction.type.label,
                            color: trade.transaction.type.tint,
                            icon: trade.transaction.type == "P" ? "arrow.down.right.circle.fill" : (trade.transaction.type == "S" ? "arrow.up.right.circle.fill" : "arrow.left.and.right.circle.fill")
                        )
                        .padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 32)
                    .background(
                        LinearGradient(colors: [chamberGradient.opacity(0.2), AppTheme.background], startPoint: .top, endPoint: .bottom)
                    )

                    VStack(spacing: 16) {
                        DetailSection("Trade Summary") {
                            HStack {
                                Text("Politician")
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text(trade.member.party?.partyEmoji ?? "")
                                Text(trade.member.name ?? "Unknown")
                                    .fontWeight(.bold)
                            }
                            .font(.subheadline)
                            
                            DetailRow("Amount", trade.amountLabel)
                            DetailRow("Owner", trade.transaction.owner?.capitalized ?? "Unavailable")
                            DetailRow("Confidence", "\(Int((trade.confidence * 100).rounded()))%")
                        }

                        DetailSection("Timeline") {
                            DetailRow("Traded", trade.transaction.date.longDate)
                            DetailRow("Filed", trade.filing.filedDate.longDate)
                            DetailRow("Discovered", trade.filing.firstSeenAt.longDate)
                        }

                        DetailSection("Company Info") {
                            DetailRow("Sector", trade.asset.sector ?? "Not Enriched Yet")
                            DetailRow("Market Cap", trade.asset.marketCapBucket?.capitalized ?? "Not Enriched Yet")
                        }

                        if let pdfURL = store.api.documentPDFURL(docId: trade.docId) {
                            Button {
                                openURL(pdfURL)
                            } label: {
                                Label("View Filing PDF", systemImage: "doc.richtext")
                                    .font(.headline)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(chamberGradient)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                            .padding(.top, 8)
                        }

                        if let sourceURL = trade.filing.sourceUrl,
                           let url = URL(string: sourceURL),
                           url.scheme == "https" || url.scheme == "http" {
                            Button {
                                openURL(url)
                            } label: {
                                Label("View Source Filing", systemImage: "doc.text.magnifyingglass")
                                    .font(.headline)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(chamberGradient)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                            .padding(.top, 8)
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            .background(AppTheme.background)
            .navigationTitle("Trade Detail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let shareURL = store.api.shareURL(queryItem: URLQueryItem(name: "trade", value: trade.id)) {
                    ToolbarItem(placement: AppToolbarPlacement.trailing) {
                        ShareLink(item: shareURL) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("Share trade")
                    }
                }
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            // The feed never re-announces a row it already served once it's
            // retracted (see app/docs/client-mobile-api.md); reconcile this
            // cached copy against `GET /trade/:id` on open so a stale,
            // retracted disclosure doesn't linger silently. CT-AUD-009.
            guard !didCheckRetraction else { return }
            didCheckRetraction = true
            if await store.reconcileIfDeprecated(trade) {
                dismiss()
            }
        }
    }
    
    private var chamberGradient: Color {
        let chamber = trade.member.chamber?.lowercased() ?? ""
        if chamber == "house" { return AppTheme.houseColor }
        if chamber == "senate" { return AppTheme.senateColor }
        if chamber == "executive" { return AppTheme.execColor }
        return .blue
    }
}
