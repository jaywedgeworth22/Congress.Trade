import Foundation
import StoreKit

/// Redeeming App Store purchases against the Congress.Trade backend.
///
/// Two rules this file exists to keep:
///
/// 1. **Apple's money is already gone by the time we run.** `product.purchase()`
///    returning `.success` means the customer was charged. Every failure after
///    that point is OUR bookkeeping failing, so it must be retried
///    automatically and never reported as if the purchase itself failed.
/// 2. **A transaction is finished only once the server has it.** Calling
///    `transaction.finish()` before `redeem_apple_purchase` succeeds throws
///    away the only durable record that we still owe this customer Premium.
///    Unfinished transactions are re-delivered by `Transaction.updates`, which
///    is what makes retry work at all.
extension CongressTradeStore {
    /// Redeem one verified StoreKit transaction, then finish it.
    ///
    /// `finish()` is deliberately *after* the server call: an unfinished
    /// transaction is redelivered to `observeAppleTransactions()` on the next
    /// launch, so a failed redeem self-heals instead of stranding a paying
    /// customer on the free tier.
    func redeemAppleTransaction(_ transaction: Transaction, jws: String) async throws {
        _ = try await api.redeemApplePurchase(signedTransaction: jws)
        await transaction.finish()
        await refresh()
    }

    /// Redeem every current entitlement on this Apple Account. Returns whether
    /// any active subscription was found. Used by Restore Purchases and by the
    /// launch-time sweep.
    @discardableResult
    func redeemCurrentAppleEntitlements() async throws -> Bool {
        var confirmed = false
        var firstError: Error?
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result else { continue }
            do {
                _ = try await api.redeemApplePurchase(signedTransaction: result.jwsRepresentation)
                await transaction.finish()
                confirmed = true
            } catch {
                // Keep going: one bad row (an entitlement already linked to a
                // different account, say) must not block the others.
                if firstError == nil { firstError = error }
            }
        }
        await refresh()
        if !confirmed, let firstError { throw firstError }
        return confirmed
    }

    /// Long-lived listener for transactions that arrive outside a purchase
    /// call: Ask to Buy approvals, renewals, subscription changes made in
    /// Settings, purchases interrupted by a crash — and, crucially, retries of
    /// a purchase whose redeem failed the first time.
    ///
    /// StoreKit 2 requires an app to observe this for the whole of its
    /// lifetime; the app previously had no such listener anywhere, which is why
    /// a redeem that failed once stayed failed until the customer happened to
    /// find Restore Purchases themselves.
    func observeAppleTransactions() async {
        for await result in Transaction.updates {
            guard case .verified(let transaction) = result else { continue }
            guard signedIn else {
                // Not signed in yet: leave it UNFINISHED so it is delivered
                // again after sign-in rather than silently dropped.
                continue
            }
            // Also intentionally left unfinished on failure — next launch retries.
            try? await redeemAppleTransaction(transaction, jws: result.jwsRepresentation)
        }
    }

    /// One-shot catch-up at launch/sign-in for anything `Transaction.updates`
    /// will not replay on its own (a transaction finished locally before the
    /// server ever recorded it — the shape the pre-2026-08-13 purchase path
    /// could produce). Silent by design: the customer is not waiting on it.
    func reconcileAppleEntitlementsQuietly() async {
        guard signedIn, !isPremium else { return }
        _ = try? await redeemCurrentAppleEntitlements()
    }
}
