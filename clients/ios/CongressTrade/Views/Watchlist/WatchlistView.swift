import SwiftUI

struct WatchlistView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @State private var sessionTokenInput = ""
    @State private var watchlistText = ""
    @State private var hasInitializedWatchlist = false
    @State private var lastLoadedWatchlistText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Session Token", text: $sessionTokenInput)
                        .privacySensitive()
                        .padding(.vertical, 4)
                        
                    Button {
                        if store.saveSessionToken(sessionTokenInput) {
                            sessionTokenInput = ""
                        }
                    } label: {
                        Label("Save Session Token", systemImage: "key.fill")
                            .fontWeight(.medium)
                    }
                    .disabled(sessionTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    
                    if store.hasStoredSessionToken {
                        Button(role: .destructive) {
                            Task { await store.signOut() }
                        } label: {
                            Label("Sign Out and Revoke Session", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                        .disabled(store.isLoggingOut)
                    }
                } header: {
                    Text("Keychain Authentication")
                } footer: {
                    Text("The iPhone app saves preferences on the backend. The phone never stores provider keys, admin tokens, crawler logic, or MCP orchestration.")
                }

                Section("Saved Tickers") {
                    TextField("AAPL, MSFT, NVDA", text: $watchlistText, axis: .vertical)
                        .tickerAutocapitalized()
                        .autocorrectionDisabled()
                        .padding(.vertical, 4)
                        
                    Button {
                        Task { await store.saveWatchlist(watchlistText) }
                    } label: {
                        if store.isSavingWatchlist {
                            ProgressView()
                        } else {
                            Label("Save Watchlist", systemImage: "checkmark.circle.fill")
                                .fontWeight(.medium)
                        }
                    }
                    .disabled(!store.signedIn || store.isSavingWatchlist)
                    
                    if let notice = store.watchlistNotice {
                        NoticeView(message: notice)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Watchlist")
            .onAppear { initializeWatchlistIfNeeded() }
            .onChange(of: store.watchlist) { _, _ in initializeWatchlistIfNeeded(force: true) }
        }
    }

    private func initializeWatchlistIfNeeded(force: Bool = false) {
        let serverText = store.watchlist.joined(separator: ", ")
        guard force || !hasInitializedWatchlist else { return }
        if !hasInitializedWatchlist || watchlistText == lastLoadedWatchlistText {
            watchlistText = serverText
        }
        lastLoadedWatchlistText = serverText
        hasInitializedWatchlist = true
    }
}
