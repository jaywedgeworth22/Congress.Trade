import SwiftUI

struct TrendsView: View {
    @EnvironmentObject private var store: CongressTradeStore
    
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let summary = store.latencySummary {
                        LatencyComparisonView(summary: summary)
                    } else {
                        ProgressView("Loading speed metrics...")
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding()
                    }
                }
                .padding()
            }
            .navigationTitle("Trends")
            .task {
                await store.refreshLatencySummary()
            }
            .refreshable {
                await store.refreshLatencySummary()
            }
        }
    }
}

struct LatencyComparisonView: View {
    let summary: LatencySummary
    let minMatched = 5
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Speed vs. Data Providers")
                .font(.headline)
            
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
        let hasStats = provider.matched >= minMatched
        let wins = provider.usFirstCount
        let losses = provider.providerFirstCount
        let ahead = hasStats && wins > losses
        let tied = hasStats && !ahead && wins == losses
        
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(provider.label)
                    .font(.subheadline)
                    .bold()
                Spacer()
                if hasStats {
                    if ahead {
                        Text("⚡ Ahead").font(.caption).bold().padding(.horizontal, 8).padding(.vertical, 4).background(Color.green.opacity(0.2)).foregroundColor(.green).cornerRadius(8)
                    } else if tied {
                        Text("⚖️ Tied").font(.caption).bold().padding(.horizontal, 8).padding(.vertical, 4).background(Color.gray.opacity(0.2)).foregroundColor(.gray).cornerRadius(8)
                    } else {
                        Text("▼ Behind").font(.caption).bold().padding(.horizontal, 8).padding(.vertical, 4).background(Color.red.opacity(0.2)).foregroundColor(.red).cornerRadius(8)
                    }
                } else {
                    Text("📊 Gathering data").font(.caption).bold().padding(.horizontal, 8).padding(.vertical, 4).background(Color.gray.opacity(0.2)).foregroundColor(.gray).cornerRadius(8)
                }
            }
            
            if hasStats {
                let winPct = provider.matched > 0 ? Int(round(100.0 * Double(wins) / Double(provider.matched))) : 0
                
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Win Rate").font(.caption).foregroundColor(.secondary).textCase(.uppercase)
                        Spacer()
                        Text("\(winPct)% (\(wins)/\(provider.matched))").font(.caption).foregroundColor(.secondary)
                    }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.gray.opacity(0.2))
                            Capsule().fill(ahead ? Color.green : (tied ? Color.gray : Color.red))
                                .frame(width: geo.size.width * CGFloat(winPct) / 100.0)
                        }
                    }
                    .frame(height: 8)
                }
                
                HStack(spacing: 12) {
                    Text(formatLead(provider.medianLeadSec))
                        .font(.title2)
                        .bold()
                        .foregroundColor(ahead ? .green : (tied ? .primary : .red))
                    
                    VStack(alignment: .leading) {
                        Text("typical lead vs. their feed").font(.caption).foregroundColor(.secondary)
                        if let p90 = provider.p90LeadSec {
                            Text("P90: \(formatLead(p90))").font(.caption2).foregroundColor(.secondary.opacity(0.7))
                        }
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.gray.opacity(0.1))
                .cornerRadius(8)
                
                HStack(spacing: 8) {
                    wltItem(val: wins, lbl: "Wins", color: .green)
                    wltItem(val: losses, lbl: "Losses", color: .red)
                    wltItem(val: provider.tieCount, lbl: "Ties", color: .primary)
                }
            } else {
                let need = minMatched - provider.matched
                VStack(alignment: .leading, spacing: 8) {
                    if provider.matched > 0 {
                        Text("We've matched **\(provider.matched)** of \(provider.candidates) filings so far. **\(need)** more needed for timing estimates.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    } else {
                        Text("Probes haven't found overlapping disclosures yet. Sample builds automatically.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Text("n = \(provider.matched) / \(provider.candidates) matched")
                        .font(.system(size: 10, weight: .bold))
                        .textCase(.uppercase)
                        .foregroundColor(.secondary.opacity(0.7))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .background(Color.gray.opacity(0.1))
                .cornerRadius(8)
            }
        }
        .padding()
        .background(Color(UIColor.secondarySystemGroupedBackground))
        .cornerRadius(12)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.gray.opacity(0.2), lineWidth: 1)
        )
    }
    
    private func wltItem(val: Int, lbl: String, color: Color) -> some View {
        VStack {
            Text("\(val)").font(.headline).foregroundColor(color)
            Text(lbl).font(.system(size: 10, weight: .bold)).textCase(.uppercase).foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(Color.gray.opacity(0.1))
        .cornerRadius(8)
    }
    
    private func formatLead(_ secs: Int?) -> String {
        guard let s = secs else { return "0s" }
        let absS = abs(Double(s))
        let sign = s > 0 ? "+" : (s < 0 ? "-" : "")
        
        let formatter = NumberFormatter()
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 1
        
        if absS < 90 { return "\(sign)\(Int(round(absS))) sec" }
        if absS < 5400 { return "\(sign)\(Int(round(absS / 60))) min" }
        if absS < 172800 {
            let val = formatter.string(from: NSNumber(value: absS / 3600)) ?? ""
            return "\(sign)\(val) hr"
        }
        let val = formatter.string(from: NSNumber(value: absS / 86400)) ?? ""
        return "\(sign)\(val) days"
    }
}
