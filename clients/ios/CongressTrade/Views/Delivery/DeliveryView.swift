import SwiftUI

struct DeliveryView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @State private var deliveryMode: DeliveryMode = .sse
    @State private var webhookURL = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Create Delivery") {
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

                    Button {
                        Task { await store.createDelivery(mode: deliveryMode, webhookURL: webhookURL) }
                    } label: {
                        if store.isCreatingDelivery {
                            ProgressView()
                        } else {
                            Label("Create Delivery", systemImage: "paperplane.fill")
                                .fontWeight(.medium)
                        }
                    }
                    .disabled(!store.signedIn || store.isCreatingDelivery)
                    
                    if let notice = store.deliveryNotice {
                        NoticeView(message: notice)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
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
        }
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
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Shown Once", systemImage: "exclamationmark.shield.fill")
                        .foregroundStyle(.orange)
                    Text("Save this credential now. Congress.Trade does not return the secret in later subscription lists.")
                        .foregroundStyle(.secondary)
                }
                if let streamURL = credential.streamURL {
                    Section("Stream URL") {
                        Text(streamURL)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                            .privacySensitive()
                    }
                }
                if let secret = credential.secret {
                    Section("Subscription Secret") {
                        Text(secret)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                            .privacySensitive()
                    }
                }
                Section {
                    ShareLink(item: credential.shareText) {
                        Label("Share Securely", systemImage: "square.and.arrow.up")
                    }
                    .disabled(credential.shareText.isEmpty)
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
    }
}
