import SwiftUI
import UIKit
// For `UNAuthorizationStatus`, which `DeliveryAlertsToggle` switches on below.
import UserNotifications

struct DeliveryView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var deliveryMode: DeliveryMode = .sse
    @State private var webhookURL = ""
    @State private var filterChambers: Set<ChamberFilter> = []
    @State private var membersText = ""
    @State private var watchlistDraft: [String] = []
    @State private var newTicker = ""
    @State private var showSubscribe = false
    @State private var showExportSheet = false

    // DELETED, deliberately: a "Notifications" section of four @AppStorage
    // toggles (`notify_all_trades` / `notify_new_buys` / `notify_new_sells` /
    // `notify_watchlist`). A grep of the whole iOS tree found those four keys
    // referenced in this file and nowhere else — no request builder, no
    // PushNotificationManager path, no subscription filter read them. They were
    // write-only local state that changed nothing, which is worse than having
    // no switches at all: it is why the owner was "unsure if any options there
    // impact push notifications or not". The one control that really does gate
    // alerts to this phone is `DeliveryAlertsToggle`, now at the top.

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DeliveryAlertsToggle()
                } header: {
                    Text("Alerts on This Phone")
                } footer: {
                    Text("The same switch as in the header menu — turning it on here turns it on everywhere.")
                }

                // Export sits beside the upgrade entry point on purpose (owner
                // asked for that adjacency): the thing you want and the thing
                // that unlocks it should not be on different screens.
                Section {
                    Button {
                        showExportSheet = true
                    } label: {
                        // Split colour: bare-glyph grey on the icon, dark
                        // legible ink on the word (owner 2026-08-21 — words
                        // must read dark, glyphs can stay the lighter grey).
                        // Without this the row inherits the app-wide
                        // `.tint(.blue)` (App.swift) and renders accent blue.
                        Label {
                            Text("Export CSV").foregroundStyle(AppTheme.wordInk)
                        } icon: {
                            Image(systemName: "arrow.down.circle").foregroundStyle(AppTheme.glyphGrey)
                        }
                    }
                    if !store.isPremium {
                        Button {
                            showSubscribe = true
                        } label: {
                            // Owner (2026-08-21): the Apple logo glyph itself
                            // must be the same near-black as the text, not
                            // blue — unlike Export CSV above, no split here.
                            Label("Subscribe with Apple", systemImage: "apple.logo")
                                .foregroundStyle(AppTheme.wordInk)
                        }
                    }
                } header: {
                    Text("Premium")
                } footer: {
                    Text("CSV export uses the filters set on the Trades tab, plus the dates you pick.  Premium is $5/month or $50/year, with a 2-week free trial.")
                }

                Section {
                    if !store.signedIn {
                        VStack(alignment: .leading, spacing: 10) {
                            DeliveryMethodExplainer()
                            Text("Sign in to create delivery alerts.")
                                .foregroundStyle(.primary)
                        }
                        .padding(.vertical, 4)
                    } else if !store.isPremium {
                        // Delivery creation is Premium-gated server-side; show
                        // the paywall up front instead of letting free users
                        // hit a raw 403 from `create_subscription`.
                        VStack(alignment: .leading, spacing: 10) {
                            Label("Premium Feature", systemImage: "star.fill")
                                .font(.headline)
                                .foregroundStyle(.orange)
                            Text(PremiumPricing.deliveryUpgradeMessage)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Button {
                                showSubscribe = true
                            } label: {
                                Label("Subscribe with Apple", systemImage: "apple.logo")
                                    .font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                            }
                            .buttonStyle(.borderedProminent)
                            // `.borderedProminent`'s fill comes from `.tint`,
                            // not `.foregroundStyle` — the app-wide
                            // `.tint(.blue)` (App.swift) would otherwise
                            // paint this pill accent blue. Owner (2026-08-21)
                            // wants near-black here, matching the plain
                            // "Subscribe with Apple" row above.
                            .tint(AppTheme.wordInk)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
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
                    Text("Create Delivery")
                } footer: {
                    // The single line that has to land for a non-developer:
                    // this whole tab is about machines, not this phone.
                    Text("Deliveries send filings to a server you run — they are not alerts on this phone.  For those, use Trade Disclosure Alerts above.")
                }

                Section("Existing Subscriptions") {
                    if store.subscriptions.isEmpty {
                        Text(store.signedIn ? "No delivery subscriptions yet." : "Sign in to manage delivery subscriptions.")
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
                    Text("New deliveries filter to these tickers. The watchlist syncs to your Congress.Trade account.")
                }

                if let summary = store.latencySummary,
                   LatencyScorecardCopy.isPubliclyVisible(summary) {
                    Section {
                        LatencyComparisonView(summary: summary)
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                    .listRowBackground(Color.clear)
                }

                // Footer links live in their own borderless row rather than a
                // section footer so they read as page chrome, not as a note
                // about the watchlist above them.
                Section {
                    AppLegalFooter()
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }
            // Regular width class only (iPad): cap the Form to a comfortable
            // reading measure and center it, instead of letting section
            // footers (e.g. the Premium blurb below) run the full canvas
            // width — iPad audit P1-3. `AppTheme.background` is
            // `.systemBackground` in both light and dark, same as the
            // NavigationStack's own default, so the margin this leaves on
            // either side is seamless rather than a visible gutter.
            .frame(maxWidth: horizontalSizeClass == .regular ? 640 : .infinity)
            .frame(maxWidth: .infinity)
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Delivery")
            .inlineNavigationTitle()
            .toolbar {
                // Sign-in, appearance, export, and Premium were otherwise
                // unreachable from this tab — the hamburger menu only lived
                // on Trends/Trades (iPad audit P2-2).
                ToolbarItem(placement: .topBarTrailing) {
                    HamburgerMenuButton()
                }
            }
            .sheet(item: $store.pendingDeliveryCredential) { credential in
                DeliveryCredentialView(credential: credential)
            }
            .sheet(isPresented: $showSubscribe) {
                PremiumSheet()
                    .environmentObject(store)
            }
            .sheet(isPresented: $showExportSheet) {
                ExportCSVSheet()
                    .environmentObject(store)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .iPadFullWidthSheet()
            }
            .onAppear {
                watchlistDraft = store.watchlist
                Task {
                    await store.refreshSignedInState()
                    if store.latencySummary == nil {
                        await store.refreshLatency()
                    }
                }
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

/// The one control on this tab that really does decide whether an alert can
/// reach this phone — the replacement for the four `notify_*` switches that
/// decided nothing.
///
/// It reflects the OS permission, which is the only thing that actually gates
/// delivery, so it cannot drift out of sync with reality and it cannot lie.
/// Two honest consequences:
/// - Turning it OFF opens iOS Settings, because an app cannot revoke its own
///   notification permission. The status line says so rather than pretending
///   the flip worked.
/// - Once permission is denied, iOS never shows the system prompt again, so
///   re-tapping routes to Settings instead of silently doing nothing.
///
/// Named distinctly from the components lane's in-flight shared version so the
/// two can coexist on main; swapping this call site for that one later is a
/// mechanical rename.
struct DeliveryAlertsToggle: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var pushManager: PushNotificationManager
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: binding) {
                Text("Trade Disclosure Alerts")
                    .font(.body.weight(.medium))
            }
            .tint(.blue)

            // Exactly one short sentence-case line — never a paragraph
            // explaining what a notification is.
            Text(statusLine)
                .font(.caption)
                .foregroundStyle(statusColor)
                .fixedSize(horizontal: false, vertical: true)
        }
        .task { await pushManager.checkPermissionStatus() }
        // Coming back from iOS Settings is the one way this state changes
        // behind the app's back.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await pushManager.checkPermissionStatus() }
        }
    }

    private var binding: Binding<Bool> {
        Binding(
            get: { pushManager.isAuthorized },
            set: { wantsOn in
                if wantsOn {
                    turnOn()
                } else {
                    openSystemSettings()
                }
            }
        )
    }

    private func turnOn() {
        switch pushManager.authorizationStatus {
        case .denied:
            openSystemSettings()
        case .notDetermined:
            Task {
                await pushManager.requestAuthorization()
                await syncIfPossible()
            }
        default:
            Task { await syncIfPossible() }
        }
    }

    private func syncIfPossible() async {
        guard pushManager.isAuthorized, store.signedIn else { return }
        await pushManager.syncTokenWithBackend(api: store.api, force: true)
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }

    private var statusLine: String {
        switch pushManager.authorizationStatus {
        case .denied:
            return "blocked in iOS Settings — tap to open them"
        case .notDetermined:
            return "off"
        default:
            break
        }
        if !store.signedIn {
            return "sign in to receive alerts on this device"
        }
        if pushManager.isBackendSynced {
            return "on — new disclosures alert this device"
        }
        if pushManager.isRegistering {
            return "registering this device…"
        }
        if pushManager.lastError != nil {
            return "this device could not be registered — toggle again to retry"
        }
        return "on — waiting for this device to register"
    }

    private var statusColor: Color {
        if pushManager.authorizationStatus == .denied { return .orange }
        if pushManager.isBackendSynced { return .green }
        if pushManager.lastError != nil { return .red }
        return .secondary
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
                    // Dark legible ink, not the app-wide blue tint (owner
                    // 2026-08-21); `.tint` is required alongside
                    // `.foregroundStyle` because the toolbar button style
                    // re-applies tint over a plain foreground colour.
                    Button("Done") { dismiss() }
                        .fontWeight(.bold)
                        .foregroundStyle(AppTheme.wordInk)
                        .tint(AppTheme.wordInk)
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
