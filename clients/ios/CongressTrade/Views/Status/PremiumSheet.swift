import StoreKit
import SwiftUI

/// The one Premium screen: what Premium unlocks, the price, the actual App
/// Store products, and a prominent way out — no "See Plans" hop in between.
///
/// This used to be two sheets. `PremiumInfoSheet` sold Premium as a benefit
/// list and then pushed `SubscribeView`, which re-explained the same thing as
/// one dense paragraph and only there showed the products. Two screens meant
/// two copies of the pricing/trial line, and they drifted (the info sheet still
/// said "1-month free trial" months after the trial became two weeks).
///
/// Every benefit line is a gate that exists in the backend today — archived
/// filing PDFs (`serveDocumentPdf` returns 402 JSON for Bearer / Accept: pdf;
/// web browsers without those still 302 to `/pricing`), full-history CSV
/// export (`/api/export/transactions.csv` → 401/402 with `feature: 'export'`),
/// and webhook/SSE delivery (402 with `feature: 'alerts'`, capped at
/// `MAX_SUBSCRIPTIONS_PER_USER = 2`). No scarcity, no countdown, nothing the
/// server does not enforce.  Filing PDF on iOS never opens Safari checkout.
///
/// It renders in full when signed out, too: hiding what Premium is until after
/// sign-in leaves the price and the benefits invisible to exactly the people
/// deciding.
///
/// Products must exist in App Store Connect:
/// - `trade.congress.premium.monthly` ($5/mo)
/// - `trade.congress.premium.annual` ($50/yr)
struct PremiumSheet: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var products: [Product] = []
    @State private var isLoadingProducts = true
    @State private var purchasingProductID: String?
    @State private var purchaseError: String?
    @State private var notice: String?
    @State private var isRestoring = false
    @State private var isOpeningManageSubscription = false
    @State private var manageSubscriptionError: String?

    private struct Benefit: Identifiable {
        let id = UUID()
        let systemImage: String
        let text: String
    }

    private let benefits: [Benefit] = [
        .init(systemImage: "doc.text", text: "Open the original filing PDF from Congress"),
        .init(systemImage: "arrow.down.doc", text: "Full-history CSV export"),
        .init(
            systemImage: "bolt.horizontal",
            text: "Instant delivery of new filings — signed webhook or SSE, up to two methods"
        ),
        .init(systemImage: "bell", text: "Push notifications when a new filing lands"),
    ]

    private var isBusy: Bool { purchasingProductID != nil || isRestoring }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("The public dashboard stays free.  Premium adds the filing itself and the ways to receive it.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(benefits) { benefit in
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Image(systemName: benefit.systemImage)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .frame(width: 22, alignment: .leading)
                                Text(benefit.text)
                                    .font(.subheadline)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }

                    Text(PremiumPricing.headline)
                        .font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)

                    actionSection

                    if let notice {
                        Text(notice)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let purchaseError {
                        Text(purchaseError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    // The frame lives on the *label*, not on the Button: a
                    // bordered style sizes its background to the label, so an
                    // outer frame widens the hit area and leaves a small pill
                    // floating in the middle of it.
                    Button {
                        dismiss()
                    } label: {
                        Text(store.isPremium ? "Done" : "Not Now")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.bordered)
                    .disabled(isBusy)

                    LegalFooterLinks(includePricing: false)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(20)
            }
            .background(AppTheme.background)
            .navigationTitle("Premium")
            .inlineNavigationTitle()
        }
        .task { await loadProducts() }
    }

    // MARK: - Sections

    @ViewBuilder
    private var actionSection: some View {
        if store.isPremium {
            subscribedSection
        } else if !store.signedIn {
            // Honest, not a dead end: the purchase has to attach to an account,
            // and the sign-in stack is one sheet behind this one.
            Text("sign in first — Premium is tied to your account")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } else if isLoadingProducts {
            HStack(spacing: 10) {
                ProgressView()
                Text("Loading plans…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 50)
        } else if products.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(PremiumPricing.emptyCatalogMessage)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                restoreButton
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(products, id: \.id) { product in
                    purchaseButton(for: product)
                }
                restoreButton
            }
        }
    }

    @ViewBuilder
    private var subscribedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(
                store.entitlementSource == "apple"
                    ? "You're subscribed to Premium through the App Store."
                    : "You already have Premium access."
            )
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            Button {
                Task { await openManageSubscription() }
            } label: {
                HStack {
                    Text(store.entitlementSource == "apple" ? "Manage on App Store" : "Manage Subscription")
                    if isOpeningManageSubscription {
                        Spacer()
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isOpeningManageSubscription)
            .accessibilityHint(
                store.entitlementSource == "apple"
                    ? "Opens the App Store subscriptions page"
                    : "Opens the Congress.Trade billing portal"
            )

            if let manageSubscriptionError {
                Text(manageSubscriptionError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// The first product is the prominent one; the rest are bordered so the
    /// screen has a single obvious primary action rather than two competing
    /// filled buttons.
    @ViewBuilder
    private func purchaseButton(for product: Product) -> some View {
        let isPrimary = product.id == products.first?.id
        let button = Button {
            Task { await purchase(product) }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(product.displayName)
                        .font(.body.weight(.semibold))
                    if let subtitle = PremiumPricing.subtitle(for: product) {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if purchasingProductID == product.id {
                    ProgressView()
                } else {
                    Text(product.displayPrice)
                        .font(.body.weight(.bold))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 4)
        }
        .disabled(isBusy)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Starts an App Store purchase for \(product.displayName) at \(product.displayPrice)")

        if isPrimary {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }

    private var restoreButton: some View {
        Button {
            Task { await restore() }
        } label: {
            HStack {
                Text("Restore Purchases")
                if isRestoring {
                    Spacer()
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.tint)
        .disabled(isBusy)
        .accessibilityHint("Re-sends any active App Store subscription to Congress.Trade")
    }

    // MARK: - StoreKit

    private func loadProducts() async {
        isLoadingProducts = true
        do {
            let ids = Set(AppleIAPProduct.allCases.map(\.rawValue))
            products = try await Product.products(for: ids).sorted { $0.price < $1.price }
        } catch {
            products = []
            purchaseError = error.localizedDescription
        }
        isLoadingProducts = false
    }

    private func purchase(_ product: Product) async {
        purchasingProductID = product.id
        purchaseError = nil
        notice = nil
        defer { purchasingProductID = nil }
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                let transaction = try checkVerified(verification)
                notice = "Purchase confirmed.  Unlocking Premium…"
                // StoreKit 2 VerificationResult.jwsRepresentation is the App Store JWS.
                try await store.redeemAppleTransaction(transaction, jws: verification.jwsRepresentation)
                notice = "Premium unlocked.  You can create Delivery alerts now."
                try? await Task.sleep(for: .seconds(1.2))
                dismiss()
            case .userCancelled:
                notice = nil
            case .pending:
                notice = "Purchase is pending approval.  Premium unlocks as soon as it clears — you don't need to buy again."
            @unknown default:
                notice = "Purchase finished with an unknown status."
            }
        } catch {
            purchaseError = PremiumPricing.redeemFailureMessage(error)
        }
    }

    private func restore() async {
        isRestoring = true
        purchaseError = nil
        notice = nil
        defer { isRestoring = false }
        do {
            try await AppStore.sync()
            let confirmed = try await store.redeemCurrentAppleEntitlements()
            notice = confirmed
                ? "Purchases restored."
                : "No active Premium subscription found on this Apple Account."
        } catch {
            purchaseError = PremiumPricing.redeemFailureMessage(error)
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

    /// Same `resolveManageSubscriptionURL` routing as the account sheet — see
    /// `Store/ManageSubscription.swift`. On failure this shows an inline
    /// message rather than ever falling back to the App Store link for a
    /// Stripe subscriber, who has nothing to manage there.
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
}

// MARK: - Shared Premium copy

/// One home for the price/trial line so the phone can never drift from the web
/// again. The trial length here must match BOTH the Stripe default
/// (`STRIPE_TRIAL_DAYS`, 14 days — `app/src/billing/routes.ts`) and the
/// introductory offer configured on each product in App Store Connect. Change
/// it in all three or the app is quoting a trial Apple will not honor.
///
/// Verified 2026-08-14 against live ASC + Infisical: both
/// `trade.congress.premium.monthly` and `.annual` carry `FREE_TRIAL` /
/// `TWO_WEEKS` (start 2026-08-12, no end); US prices $5 / $50; prod
/// `STRIPE_TRIAL_DAYS=14`. Receipt:
/// `docs/rollouts/2026-08-14-premium-trial-asc-verified.md`.
enum PremiumPricing {
    static let headline = "$5/month  •  $50/year  •  2-week free trial"

    /// Empty StoreKit catalog: Restore stays, website checkout does not.
    /// Guideline 3.1.1 — same digital good as IAP.
    static let emptyCatalogMessage = "In-app purchase isn't available.  Try again later."

    /// Delivery paywall.  In-App Purchase only — no website Stripe CTA.
    static let deliveryUpgradeMessage =
        "2-week free trial, then $5/month or $50/year.  Upgrade with In-App Purchase to create SSE/webhook deliveries.  Existing deliveries still appear below."

    static func subtitle(for product: Product) -> String? {
        switch AppleIAPProduct(rawValue: product.id) {
        case .monthly: return "Billed monthly.  Cancel anytime."
        case .annual: return "Billed yearly — two months cheaper than monthly."
        case nil: return nil
        }
    }

    /// Never hand a raw transport/HTTP string to someone Apple has already
    /// charged. The purchase itself succeeded; what failed is our side
    /// recording it, and the recovery is Restore Purchases, not buying again.
    static func redeemFailureMessage(_ error: Error) -> String {
        let detail = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        return "Apple took the purchase, but Congress.Trade could not confirm it yet.  "
            + "Nothing was lost — tap Restore Purchases in a moment, or reopen the app.  ("
            + detail + ")"
    }
}
