-- 0022_stripe_webhook_events.sql
-- Durable idempotency ledger for Stripe webhook event delivery.

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_received
  ON stripe_webhook_events (received_at DESC);
