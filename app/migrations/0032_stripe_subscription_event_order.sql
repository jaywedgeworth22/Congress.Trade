-- Prevent out-of-order Stripe subscription webhooks from rolling billing state
-- backward. Stripe does not guarantee event delivery order, so each
-- subscription keeps the newest applied event order independently.

ALTER TABLE stripe_webhook_events ADD COLUMN claim_token TEXT;
ALTER TABLE stripe_webhook_events ADD COLUMN claim_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_claim_expiry
  ON stripe_webhook_events (processed_at, claim_expires_at);

CREATE TABLE IF NOT EXISTS stripe_subscription_event_state (
  subscription_id      TEXT PRIMARY KEY,
  customer_id          TEXT NOT NULL,
  last_event_created   INTEGER NOT NULL,
  last_event_priority  INTEGER NOT NULL,
  last_event_id        TEXT NOT NULL,
  last_event_type      TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stripe_subscription_event_customer
  ON stripe_subscription_event_state (customer_id, last_event_created DESC);
