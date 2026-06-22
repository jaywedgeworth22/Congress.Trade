-- 0004_billing.sql
-- Stripe billing columns for end-user accounts (freemium paywall).
-- Layered onto the `users` table from 0003_users.sql. A user is "premium" when
-- subscription_status is 'trialing' or 'active' (see billing/entitlement.ts).
-- Distinct from the delivery `subscriptions` table (webhook/SSE targets).

ALTER TABLE users ADD COLUMN stripe_customer_id     TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN subscription_status    TEXT;
ALTER TABLE users ADD COLUMN plan                   TEXT;        -- 'monthly' | 'annual'
ALTER TABLE users ADD COLUMN current_period_end     TEXT;        -- ISO-8601
ALTER TABLE users ADD COLUMN cancel_at_period_end   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN trial_end              TEXT;        -- ISO-8601

-- Webhooks identify the user by Stripe customer id, so index it. SQLite allows
-- many NULLs under a UNIQUE index, so this stays correct before anyone subscribes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id);
