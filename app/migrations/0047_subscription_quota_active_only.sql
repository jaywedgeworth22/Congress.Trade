-- 0047_subscription_quota_active_only.sql
-- Fixes the "lifetime subscription lockout" bug: trg_subscriptions_total_quota
-- previously counted every historical subscription row (active + deactivated)
-- toward the 20-per-client cap. With no hard-delete path for a subscription,
-- an account that only ever deactivated old subscriptions could permanently
-- lock itself out of creating another one after 20 lifetime rows. Recreate
-- the trigger so only currently-active rows count, matching the corrected
-- application-level preflight in assertSubscriptionQuota
-- (src/delivery/subscriptions.ts). Deactivating a subscription now reliably
-- frees its slot against the creation quota.

DROP TRIGGER IF EXISTS trg_subscriptions_total_quota;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_total_quota
BEFORE INSERT ON subscriptions
WHEN (
  SELECT COUNT(*) FROM subscriptions
   WHERE client_id = NEW.client_id AND active = 1
) >= 20
BEGIN
  SELECT RAISE(ABORT, 'subscription total quota exceeded');
END;
