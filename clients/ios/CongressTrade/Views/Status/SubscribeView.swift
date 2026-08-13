import StoreKit
import SwiftUI

/// In-app purchase sheet for Premium (StoreKit 2).
/// Products must exist in App Store Connect:
/// - `trade.congress.premium.monthly` ($5/mo after 1-month intro if configured)
/// - `trade.congress.premium.annual` ($50/yr)
struct SubscribeView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var products: [Product] = []
    @State private var isLoading = true
    @State private var purchaseError: String?
    @State private var isPurchasing = false
    @State private var notice: String?
    @State private var isOpeningManageSubscription = false
    @State private var manageSubscriptionError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("2-week free trial, then $5/month or $50/year. Users get access to filings (PDF typically) from government sources and our backups/copies, can configure up to 2 delivery methods (SSE streams, webhooks) to enable other apps to receive trades when published, receive push notifications, and export the database in CSV format.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if store.isPremium {
                    Section("Your Subscription") {
                        Text(
                            store.entitlementSource == "apple"
                                ? "You're subscribed to Premium through the App Store."
                                : "You already have Premium access."
                        )
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        Button {
                            Task { await openManageSubscription() }
                        } label: {
                            HStack {
                                Label(
                                    store.entitlementSource == "apple" ? "Manage on App Store" : "Manage Subscription",
                                    systemImage: "creditcard"
                                )
                                if isOpeningManageSubscription {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(isOpeningManageSubscription)
                        .accessibilityHint(
                            store.entitlementSource == "apple"
                                ? "Opens the App Store subscriptions page"
                                : "Opens the Congress.Trade billing portal"
                        )
                        if let manageSubscriptionError {
                            Text(manageSubscriptionError)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
                } else if isLoading {
                    Section {
                        ProgressView("Loading products…")
                    }
                } else if products.isEmpty {
                    Section {
                        Text("In-app products are not available yet. You can still subscribe on the website.")
                            .foregroundStyle(.secondary)
                        if let url = store.api.upgradeURL {
                            Link("Open Congress.Trade pricing", destination: url)
                        }
                    }
                } else {
                    Section("Subscribe") {
                        ForEach(products, id: \.id) { product in
                            Button {
                                Task { await purchase(product) }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(product.displayName)
                                            .font(.body.weight(.semibold))
                                    }
                                    Spacer()
                                    if isPurchasing {
                                        ProgressView()
                                    } else {
                                        Text(product.displayPrice)
                                            .font(.body.weight(.bold))
                                    }
                                }
                            }
                            .disabled(isPurchasing)
                            .accessibilityElement(children: .combine)
                            .accessibilityHint("Starts an App Store purchase for \(product.displayName) at \(product.displayPrice)")
                        }
                    }
                }

                if let notice {
                    Section {
                        Text(notice)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                if let purchaseError {
                    Section {
                        Text(purchaseError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button("Restore Purchases") {
                        Task { await restore() }
                    }
                    .disabled(isPurchasing)
                    .accessibilityHint("Re-sends any active App Store subscription to Congress.Trade")
                }
            }
            .navigationTitle("Premium")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task { await loadProducts() }
        }
    }

    /// Routes by `entitlementSource` — see `Store/ManageSubscription.swift`.
    /// On failure, shows a helpful inline message rather than ever falling
    /// back to the App Store link for a Stripe subscriber.
    private func openManageSubscription() async {
        manageSubscriptionError = nil
        isOpeningManageSubscription = true
        defer { isOpeningManageSubscription = false }
        switch await store.resolveManageSubscriptionURL() {
        case .url(let url):
            openURL(url)
        case .failed(let message):
            manageSubscriptionError = message
        }
    }

    private func loadProducts() async {
        isLoading = true
        purchaseError = nil
        do {
            let ids = Set(AppleIAPProduct.allCases.map(\.rawValue))
            products = try await Product.products(for: ids).sorted { $0.price < $1.price }
        } catch {
            purchaseError = error.localizedDescription
            products = []
        }
        isLoading = false
    }

    private func purchase(_ product: Product) async {
        isPurchasing = true
        purchaseError = nil
        notice = nil
        defer { isPurchasing = false }
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                let transaction = try checkVerified(verification)
                // StoreKit 2 VerificationResult.jwsRepresentation is the App Store JWS.
                let jws = verification.jwsRepresentation
                _ = try await store.api.redeemApplePurchase(signedTransaction: jws)
                await transaction.finish()
                await store.refresh()
                notice = "Premium unlocked. You can create Delivery alerts now."
                try? await Task.sleep(for: .seconds(1.2))
                dismiss()
            case .userCancelled:
                notice = "Purchase canceled."
            case .pending:
                notice = "Purchase is pending approval."
            @unknown default:
                notice = "Purchase finished with an unknown status."
            }
        } catch {
            purchaseError = error.localizedDescription
        }
    }

    private func restore() async {
        isPurchasing = true
        purchaseError = nil
        notice = nil
        defer { isPurchasing = false }
        do {
            try await AppStore.sync()
            var confirmed = false
            for await result in Transaction.currentEntitlements {
                guard case .verified(let transaction) = result else { continue }
                let jws = result.jwsRepresentation
                _ = try await store.api.redeemApplePurchase(signedTransaction: jws)
                await transaction.finish()
                confirmed = true
            }
            await store.refresh()
            notice = confirmed ? "Purchases restored." : "No active Premium subscription found."
        } catch {
            purchaseError = error.localizedDescription
        }
    }

    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let safe):
            return safe
        }
    }
}
