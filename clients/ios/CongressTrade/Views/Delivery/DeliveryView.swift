import SwiftUI
import UIKit

struct DeliveryView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @State private var deliveryMode: DeliveryMode = .sse
    @State private var webhookURL = ""
    @State private var filterChambers: Set<ChamberFilter> = []
    @State private var membersText = ""
    @State private var watchlistDraft: [String] = []
    @State private var newTicker = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Create Delivery") {
                    if !store.signedIn {
                        Text("Sign in to create delivery alerts.")
                            .foregroundStyle(.secondary)
                    } else if !store.isPremium {
                        // Delivery creation is Premium-gated server-side; show
                        // the paywall up front instead of letting free users
                        // hit a raw 403 from `create_subscription`.
                        VStack(alignment: .leading, spacing: 10) {
                            Label("Premium Feature", systemImage: "star.fill")
                                .font(.headline)
                                .foregroundStyle(.orange)
                            Text("Delivery alerts push new filings to your devices the moment Congress.Trade sees them. Upgrade to Premium to create SSE or webhook deliveries.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            if let url = store.api.upgradeURL {
                                Link(destination: url) {
                                    Label("Upgrade on congress.trade", systemImage: "safari")
                                        .font(.subheadline.weight(.semibold))
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 10)
                                }
                                .buttonStyle(.borderedProminent)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                            }
                        }
                        .padding(.vertical, 4)
                    } else {
                        Picker("Mode", selection: $deliveryMode) {
                            ForEach(DeliveryMode.allCases) { mode in
                                Text(mode.rawValue).tag(mode)
                            }
                        }
                        .pickerStyle(.segmented)
                        .padding(.vertical, 4)

                        if deliveryMode == .webhook {
                            TextField("https://example.com/webhook", text: $webhookURL)
                                .urlKeyboard()
                                .neverAutocapitalized()
                                .autocorrectionDisabled()
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            Text("Chambers")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            HStack(spacing: 8) {
                                ForEach(ChamberFilter.allCases) { chamber in
                                    FilterChip(
                                        title: chamber.shortLabel,
                                        isSelected: filterChambers.contains(chamber)
                                    ) {
                                        if filterChambers.contains(chamber) {
                                            filterChambers.remove(chamber)
                                        } else {
                                            filterChambers.insert(chamber)
                                        }
                                    }
                                    .accessibilityLabel(chamber.label)
                                }
                            }
                            Text("No selection delivers all chambers.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)

                        TextField("Members (comma separated, optional)", text: $membersText)
                            .neverAutocapitalized()
                            .autocorrectionDisabled()

                        Button {
                            Task {
                                await store.createDelivery(
                                    mode: deliveryMode,
                                    webhookURL: webhookURL,
                                    chambers: filterChambers,
                                    members: Self.parseMembers(membersText)
                                )
                            }
                        } label: {
                            if store.isCreatingDelivery {
                                ProgressView()
                            } else {
                                Label("Create Delivery", systemImage: "paperplane.fill")
                                    .fontWeight(.medium)
                            }
                        }
                        .disabled(store.isCreatingDelivery)
                    }

                    if let notice = store.deliveryNotice {
                        NoticeView(message: notice)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                }

                Section {
                    if !store.signedIn {
                        Text("Sign in to manage your watchlist.")
                            .foregroundStyle(.secondary)
                    } else {
                        if watchlistDraft.isEmpty {
                            Text("No tickers yet. An empty watchlist delivers everything.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(watchlistDraft, id: \.self) { ticker in
                            HStack {
                                Text(ticker)
                                    .font(.body.weight(.semibold).monospaced())
                                Spacer()
                                Button(role: .destructive) {
                                    watchlistDraft.removeAll { $0 == ticker }
                                } label: {
                                    Image(systemName: "minus.circle.fill")
                                        .foregroundStyle(.red)
                                }
                                .accessibilityLabel("Remove \(ticker)")
                            }
                        }
                        HStack {
                            TextField("Add ticker (e.g. NVDA)", text: $newTicker)
                                .tickerAutocapitalized()
                                .autocorrectionDisabled()
                            Button("Add") {
                                let parsed = CongressTradeStore.parseTickers(newTicker)
                                for ticker in parsed where !watchlistDraft.contains(ticker) {
                                    watchlistDraft.append(ticker)
                                }
                                newTicker = ""
                            }
                            .disabled(CongressTradeStore.parseTickers(newTicker).isEmpty)
                        }
                        if watchlistDraft != store.watchlist {
                            Button {
                                Task { await store.saveWatchlist(watchlistDraft.joined(separator: ",")) }
                            } label: {
                                if store.isSavingWatchlist {
                                    ProgressView()
                                } else {
                                    Label("Save Watchlist", systemImage: "checkmark.circle")
                                        .fontWeight(.medium)
                                }
                            }
                            .disabled(store.isSavingWatchlist)
                        }
                    }
                } header: {
                    Text("Watchlist")
                } footer: {
                    Text("New deliveries filter to these tickers. The watchlist syncs to your Congress.Trade account.")
                }

                Section("Existing Subscriptions") {
                    if store.subscriptions.isEmpty {
                        Text(store.signedIn ? "No delivery subscriptions yet." : "Sign in to manage delivery subscriptions.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(store.subscriptions) { subscription in
                            SubscriptionRow(subscription: subscription) {
                                Task { await store.toggleSubscription(subscription) }
                            }
                            .disabled(store.subscriptionIDsInFlight.contains(subscription.id))
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Delivery")
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button {
                        Task { await store.refreshSignedInState() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .fontWeight(.semibold)
                    }
                    .accessibilityLabel("Refresh deliveries")
                }
            }
            .sheet(item: $store.pendingDeliveryCredential) { credential in
                DeliveryCredentialView(credential: credential)
            }
            .onAppear { watchlistDraft = store.watchlist }
            .onChange(of: store.watchlist) { _, newValue in
                watchlistDraft = newValue
            }
        }
    }

    /// Members are free-text names (not symbols), so no uppercasing.
    private static func parseMembers(_ text: String) -> [String] {
        text
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}

struct SubscriptionRow: View {
    let subscription: Subscription
    let onToggle: () -> Void

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text(subscription.delivery.uppercased())
                    .font(.headline)
                Text(subscription.targetUrl ?? subscription.streamUrl ?? "SSE stream")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text("Cursor \(subscription.cursor)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(subscription.active ? "Pause" : "Resume", action: onToggle)
                .buttonStyle(.bordered)
                .tint(subscription.active ? .orange : .green)
                .clipShape(Capsule())
        }
        .padding(.vertical, 4)
    }
}

struct DeliveryCredentialView: View {
    let credential: DeliveryCredential
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @State private var copiedField: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Shown Once — Not Recoverable", systemImage: "exclamationmark.shield.fill")
                        .foregroundStyle(.orange)
                        .font(.headline)
                    Text("Congress.Trade never returns this secret again, in this app or any other client. Copy it somewhere safe now; if you lose it, pause this delivery and create a new one.")
                        .foregroundStyle(.secondary)
                }
                if let streamURL = credential.streamURL {
                    Section("Stream URL") {
                        Text(streamURL)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                            .privacySensitive()
                        CopyButton(label: "Copy Stream URL", value: streamURL, copiedField: $copiedField)
                    }
                }
                if let secret = credential.secret {
                    Section("Subscription Secret") {
                        Text(secret)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                            .privacySensitive()
                        CopyButton(label: "Copy Secret", value: secret, copiedField: $copiedField)
                    }
                }
            }
            .navigationTitle("Delivery Credential")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: AppToolbarPlacement.trailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.bold)
                }
            }
        }
        .onDisappear {
            // The secret is shown exactly once; drop it from app state as soon
            // as this view goes away rather than relying only on the sheet
            // binding to nil it out. CT-AUD-023.
            store.clearPendingDeliveryCredential()
        }
    }
}

/// Explicit, deliberate copy control for a one-time secret. Replaces the
/// generic system `ShareLink`, which hands the secret to an arbitrary
/// share-sheet destination (Messages, AirDrop, third-party apps, ...) with no
/// record of where it went. CT-AUD-023.
private struct CopyButton: View {
    let label: String
    let value: String
    @Binding var copiedField: String?

    var body: some View {
        Button {
            UIPasteboard.general.string = value
            copiedField = value
            Task {
                try? await Task.sleep(for: .seconds(2))
                if copiedField == value { copiedField = nil }
            }
        } label: {
            Label(copiedField == value ? "Copied" : label, systemImage: copiedField == value ? "checkmark" : "doc.on.doc")
        }
        .buttonStyle(.bordered)
    }
}
