import Foundation

/// Routes "Manage Subscription" to the correct surface for the signed-in
/// user's entitlement source, shared by every manage-subscription entry
/// point (the header hamburger's `AccountQuickMenu` + `SubscribeView`'s
/// "Your Subscription" section).
///
/// `entitlement.source` (`"stripe" | "apple" | nil`) exists precisely to
/// make this choice (`app/docs/client-mobile-api.md` "Entitlement
/// semantics"): Apple IAP subscribers manage their subscription on the App
/// Store; Stripe subscribers have NOTHING to manage there. Apple IAP was
/// disabled until 2026-08-09, so every pre-existing Premium user is
/// Stripe-sourced (or `nil`, its safe default) — routing everyone to the App
/// Store page regardless of source, as both call sites previously did,
/// landed real paying Stripe customers on a dead page.
extension CongressTradeStore {
    enum ManageSubscriptionOutcome {
        case url(URL)
        case failed(message: String)
    }

    /// Resolves where "Manage Subscription" should send the user:
    /// - `source == "apple"` → the App Store subscriptions page directly (no
    ///   network call — Apple, not us, owns that state).
    /// - Stripe or `nil` (the safe default) → `POST /billing/portal` mints a
    ///   short-lived Stripe-hosted portal URL (web parity,
    ///   `app/src/billing/routes.ts`). On failure (not signed in, portal not
    ///   configured, no Stripe customer yet, offline), returns a helpful
    ///   message instead of ever falling back to the Apple URL — a Stripe
    ///   payer has nothing to manage there.
    func resolveManageSubscriptionURL() async -> ManageSubscriptionOutcome {
        if entitlementSource == "apple" {
            return .url(CongressTradeAPIClient.appStoreManageSubscriptionsURL)
        }
        do {
            let url = try await api.billingPortalURL()
            return .url(url)
        } catch {
            return .failed(message: Self.portalFailureMessage(for: error))
        }
    }

    private static func portalFailureMessage(for error: Error) -> String {
        guard let apiError = error as? APIError else {
            return "Couldn't open your billing portal. Please try again."
        }
        switch apiError {
        case .transport:
            return apiError.isOffline
                ? "You're offline. Reconnect and try Manage Subscription again."
                : "Couldn't reach Congress.Trade. Please try again."
        case .server(let status, let message, _):
            switch status {
            case 401:
                return "Your session needs a refresh — sign out and back in, then retry Manage Subscription."
            case 503:
                return "The billing portal isn't available right now. Please try again shortly, or contact support."
            case 400:
                return "No billing account found for Manage Subscription yet. Contact support if this seems wrong."
            default:
                return message.isEmpty ? "Couldn't open your billing portal. Please try again." : message
            }
        case .invalidResponse:
            return "Couldn't open your billing portal right now. Please try again."
        }
    }
}
