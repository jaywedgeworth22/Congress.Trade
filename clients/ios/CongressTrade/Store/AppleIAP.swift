import Foundation
import StoreKit

/// Redeeming App Store purchases against the Congress.Trade backend.
///
/// Three rules this file exists to keep:
///
/// 1. **Apple's money is already gone by the time we run.** `product.purchase()`
///    returning `.success` means the customer was charged. Every failure after
///    that point is OUR bookkeeping failing, so it must be retried
///    automatically and never reported as if the purchase itself failed.
/// 2. **A transaction is finished only once the server has it** (with one
///    exception — see `observeAppleTransactions()`). Calling
///    `transaction.finish()` before the server call succeeds throws away the
///    only durable record that we still owe this customer Premium.
///    Unfinished transactions are re-delivered by `Transaction.updates`, which
///    is what makes retry work at all.
/// 3. **No account is required to buy** (Guideline 5.1.1(v)). PDF download and
///    CSV export are content, not account-specific functionality, so a
///    signed-out purchase must work end to end: `redeemAppleTransactionAnonymously`
///    records it against this DEVICE via `POST
///    /api/client/v1/entitlements/apple/redeem`, no session required. Signing
///    in later is optional and only adds cross-device access + Delivery
///    alerts (see `linkAppleEntitlementIfNeeded`) — it is never the gate on
///    the purchase itself.
extension CongressTradeStore {
    /// Redeem one verified StoreKit transaction against the SIGNED-IN
    /// account, then finish it.
    ///
    /// `finish()` is deliberately *after* the server call: an unfinished
    /// transaction is redelivered to `observeAppleTransactions()` on the next
    /// launch, so a failed redeem self-heals instead of stranding a paying
    /// customer on the free tier.
    func redeemAppleTransaction(_ transaction: Transaction, jws: String) async throws {
        _ = try await api.redeemApplePurchase(signedTransaction: jws)
        await transaction.finish()
        await refresh()
        await refreshLocalAppleEntitlement()
    }

    /// Anonymous counterpart of `redeemAppleTransaction` (Guideline
    /// 5.1.1(v)) — no session required or sent. Records the purchase against
    /// this DEVICE (`apple_subscriptions.user_id = NULL`) and caches the
    /// resulting device entitlement token so PDF / CSV requests can present
    /// it. Returns whether the purchase is now recognized as Premium.
    ///
    /// Does NOT finish the transaction — callers decide (see call sites):
    /// the live `.updates` listener wants it left open so it is redelivered
    /// once the person signs in and can be linked to an account; the
    /// `currentEntitlements`-based sweeps (reconcile/restore) finish it
    /// themselves because sign-in re-derives the same transaction from
    /// `Transaction.currentEntitlements`, not from `.updates` redelivery.
    @discardableResult
    func redeemAppleTransactionAnonymously(jws: String) async throws -> Bool {
        let result = try await api.redeemAppleEntitlementAnonymously(signedTransaction: jws)
        if let token = result.deviceEntitlementToken, !token.isEmpty {
            try? api.deviceEntitlementStore.save(token)
        }
        await refreshLocalAppleEntitlement()
        return result.entitlement?.premium == true
    }

    /// Recomputes `hasLocalAppleEntitlement` from `Transaction.currentEntitlements`.
    /// UI state only — never treated as authorization for a network request;
    /// every server call still carries a real signed JWS or the server-issued
    /// device entitlement token, never this flag by itself.
    func refreshLocalAppleEntitlement() async {
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  AppleIAPProduct(rawValue: transaction.productID) != nil,
                  transaction.revocationDate == nil else { continue }
            if let expirationDate = transaction.expirationDate, expirationDate < Date() { continue }
            hasLocalAppleEntitlement = true
            return
        }
        hasLocalAppleEntitlement = false
    }

    /// Redeem every current entitlement on this Apple Account. Returns whether
    /// any active subscription was found. Used by Restore Purchases and by the
    /// launch-time sweep.
    ///
    /// Signed in: authenticated redeem (attaches to the account). Signed out:
    /// anonymous redeem (Guideline 5.1.1(v) — device-scoped, no account
    /// required). Either way the visible outcome is the same: Premium
    /// unlocks on this device.
    @discardableResult
    func redeemCurrentAppleEntitlements() async throws -> Bool {
        var confirmed = false
        var firstError: Error?
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result else { continue }
            do {
                if signedIn {
                    _ = try await api.redeemApplePurchase(signedTransaction: result.jwsRepresentation)
                } else {
                    _ = try await redeemAppleTransactionAnonymously(jws: result.jwsRepresentation)
                }
                await transaction.finish()
                confirmed = true
            } catch {
                // Keep going: one bad row must not block the others. Signed
                // in, that's typically "already linked to a different
                // account"; signed out, the anonymous route returns the same
                // 409 when this transaction is already claimed by SOME
                // account — either way restore()'s copy stays "no active
                // subscription found on this Apple Account" for this row,
                // which is accurate: nothing new was found for the CURRENT
                // caller.
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
                // Not signed in: grant this DEVICE its own access right away
                // (Guideline 5.1.1(v) — a purchase that is not account-based
                // must not wait on an account) but leave the transaction
                // UNFINISHED so it is delivered again after sign-in and can
                // still be linked to an account, rather than silently dropped.
                try? await redeemAppleTransactionAnonymously(jws: result.jwsRepresentation)
                continue
            }
            // Also intentionally left unfinished on failure — next launch retries.
            try? await redeemAppleTransaction(transaction, jws: result.jwsRepresentation)
        }
    }

    /// One-shot catch-up at launch for anything `Transaction.updates` will not
    /// replay on its own (a transaction finished locally before the server
    /// ever recorded it). Silent by design: the customer is not waiting on it.
    ///
    /// Runs signed in OR signed out — a signed-out launch also refreshes/
    /// claims this device's own anonymous access (Guideline 5.1.1(v)), which
    /// doubles as how the device entitlement token gets renewed before its
    /// short (<=24h) expiry on every app open.
    func reconcileAppleEntitlementsQuietly() async {
        await refreshLocalAppleEntitlement()
        guard !isPremium else { return }
        _ = try? await redeemCurrentAppleEntitlements()
    }

    /// Called once, right after a successful sign-in, to claim any purchase
    /// this device already made anonymously under the account that just
    /// signed in (`link_apple_entitlement`). Silent by design (same pattern
    /// as `reconcileAppleEntitlementsQuietly`): a 409 here means the
    /// transaction is already linked to a DIFFERENT account, which is not an
    /// error for THIS account — it keeps whatever entitlement it already has
    /// (Stripe or none), and the device keeps its anonymous access via the
    /// cached device token either way. Only surface that conflict when the
    /// person explicitly taps Restore Purchases (`PremiumSheet.restore()`).
    func linkAppleEntitlementIfNeeded() async {
        guard signedIn, !isPremium, hasLocalAppleEntitlement else { return }
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  AppleIAPProduct(rawValue: transaction.productID) != nil else { continue }
            _ = try? await api.linkAppleEntitlement(signedTransaction: result.jwsRepresentation)
            await transaction.finish()
        }
        await refresh()
    }
}
