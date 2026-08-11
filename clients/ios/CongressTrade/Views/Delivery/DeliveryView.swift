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
    @State private var showPremiumInfo = false
    @State private var showExport = false
    @State private var editingSubscriptionId: String?

    // The four `notify_*` @AppStorage toggles that used to head this screen
    // ("All Trades" / "New Buys" / "New Sells" / "Watchlist") were removed: a
    // tree-wide grep found the keys referenced nowhere but their own bindings,
    // so they were write-only UserDefaults that changed nothing.  They were the
    // direct cause of the owner's "unsure if any options there impact push
    // notifications" — they read exactly like notification settings and did
    // nothing.  The real phone-alert switch now sits at the top of this screen,
    // and it is the same one the header menu shows.

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TradeDisclosureAlertsToggle()
                } header: {
                    Text("On This Phone")
                } footer: {
                    Text("The same switch as in the menu at the top of Trends and Trades.  Nothing else on this screen changes phone notifications.")
                }

                // Premium and Export CSV sit together on purpose (owner ask):
                // export is the other thing a Premium account buys, so the
                // upgrade prompt and the feature it unlocks are one glance
                // apart instead of on separate screens.
                Section {
                    if !store.isPremium {
                        Button {
                            showPremiumInfo = true
                        } label: {
                            Label("Upgrade to Premium", systemImage: "sparkles")
                        }
                    }
                    Button {
                        showExport = true
                    } label: {
                        Label("Export CSV", systemImage: "arrow.down.doc")
                    }
                } header: {
                    Text("Premium")
                }

                Section {
                    if !store.signedIn {
                        VStack(alignment: .leading, spacing: 10) {
                            DeliveryMethodExplainer()
                            Text("Sign in to create a delivery.")
                                .foregroundStyle(.primary)
                        }
                        .padding(.vertical, 4)
                    } else if !store.isPremium {
                        // Delivery creation is Premium-gated server-side; say so
                        // up front instead of letting a free account hit a raw
                        // 403 from `create_subscription`.
                        VStack(alignment: .leading, spacing: 10) {
                            DeliveryMethodExplainer()
                            Text("Creating a delivery needs Premium.  Deliveries you already have still appear below.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Button {
                                showPremiumInfo = true
                            } label: {
                                Label("See What Premium Includes", systemImage: "sparkles")
                                    .font(.subheadline.weight(.semibold))
                            }
                        }
                        .padding(.vertical, 4)
                    } else {
                        DeliveryMethodExplainer()
                            .padding(.bottom, 2)

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
                } header: {
                    Text("Send to Your Own Server")
                } footer: {
                    Text("Feeds a server or script you run.  Not phone notifications.")
                }

                Section("Your Deliveries") {
                    if store.subscriptions.isEmpty {
                        Text(store.signedIn ? "No deliveries yet." : "Sign in to manage deliveries.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(store.subscriptions) { subscription in
                            SubscriptionRow(
                                subscription: subscription,
                                onToggle: {
                                    Task { await store.toggleSubscription(subscription) }
                                },
                                onDelete: {
                                    Task { await store.deleteSubscription(subscription) }
                                }
                            )
                            .disabled(store.subscriptionIDsInFlight.contains(subscription.id))
                        }
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
                    Text("New deliveries filter to these tickers.  The watchlist syncs to your Congress.Trade account.")
                }

                Section {
                    LegalFooterLinks()
                        .frame(maxWidth: .infinity)
                }
                .listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Delivery")
            .inlineNavigationTitle()
            .sheet(item: $store.pendingDeliveryCredential) { credential in
                DeliveryCredentialView(credential: credential)
            }
            .sheet(isPresented: $showPremiumInfo) {
                PremiumInfoSheet()
                    .environmentObject(store)
            }
            .sheet(isPresented: $showExport) {
                ExportCSVSheet()
                    .environmentObject(store)
            }
            .onAppear {
                watchlistDraft = store.watchlist
                Task { await store.refreshSignedInState() }
            }
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

/// One-line-each Webhook/SSE explainer (owner punch list #2, item 10) —
/// mirrors the web's shortened Delivery copy (lane W2, `app/src/ui/dashboardHtml.ts`),
/// replacing the old single long paragraph that tried to cover both methods
/// at once.
struct DeliveryMethodExplainer: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Webhooks: we POST each new filing to your URL, HMAC-signed.")
            Text("Live stream (SSE): one open connection that pushes filings as they land.")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

struct SubscriptionRow: View {
    let subscription: Subscription
    let onToggle: () -> Void
    var onDelete: (() -> Void)? = nil
    @State private var confirmDelete = false

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
            HStack(spacing: 8) {
                Button(subscription.active ? "Pause" : "Resume", action: onToggle)
                    .buttonStyle(.bordered)
                    .tint(subscription.active ? .orange : .green)
                    .clipShape(Capsule())
                if let onDelete {
                    Button {
                        if confirmDelete {
                            onDelete()
                            confirmDelete = false
                        } else {
                            withAnimation { confirmDelete = true }
                            // Auto-reset confirm after a few seconds so a
                            // stray tap doesn't permanently arm delete.
                            Task {
                                try? await Task.sleep(for: .seconds(4))
                                if confirmDelete { confirmDelete = false }
                            }
                        }
                    } label: {
                        Text(confirmDelete ? "Confirm?" : "Delete")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                    .clipShape(Capsule())
                    .accessibilityLabel(confirmDelete ? "Confirm delete delivery" : "Delete delivery")
                }
            }
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
