-- Durable transaction -> delivery queue handoff.
-- The transaction row and its pending outbox row are written in one D1 batch;
-- queue publication is retried independently until Cloudflare accepts it.
CREATE TABLE IF NOT EXISTS delivery_outbox (
  tx_id        TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | sending | enqueued | completed | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delivery_outbox_ready
  ON delivery_outbox (status, available_at);

-- Durable discovery -> ingest queue handoff. Rows are created atomically with
-- new filings and never backfilled by scanning historical filing rows.
CREATE TABLE IF NOT EXISTS ingestion_outbox (
  doc_id        TEXT PRIMARY KEY,
  chamber       TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | sending | enqueued | completed | failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
  available_at  TEXT NOT NULL,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingestion_outbox_ready
  ON ingestion_outbox (status, available_at);

ALTER TABLE deliveries ADD COLUMN claim_token TEXT;
ALTER TABLE deliveries ADD COLUMN lease_until TEXT;
CREATE INDEX IF NOT EXISTS idx_deliveries_lease ON deliveries (status, lease_until);

-- Durable SSE admission leases prevent one reusable stream token from opening
-- an unbounded number of long-lived D1 pollers.
CREATE TABLE IF NOT EXISTS sse_leases (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sse_leases_expiry ON sse_leases (expires_at);
CREATE INDEX IF NOT EXISTS idx_sse_leases_subscription ON sse_leases (subscription_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_sse_leases_client ON sse_leases (client_id, expires_at);

CREATE TRIGGER IF NOT EXISTS trg_sse_subscription_connection_quota
BEFORE INSERT ON sse_leases
WHEN (
  SELECT COUNT(*) FROM sse_leases
   WHERE subscription_id = NEW.subscription_id AND expires_at > NEW.created_at
) >= 2
BEGIN
  SELECT RAISE(ABORT, 'sse subscription connection quota exceeded');
END;

CREATE TRIGGER IF NOT EXISTS trg_sse_client_connection_quota
BEFORE INSERT ON sse_leases
WHEN (
  SELECT COUNT(*) FROM sse_leases
   WHERE client_id = NEW.client_id AND expires_at > NEW.created_at
) >= 5
BEGIN
  SELECT RAISE(ABORT, 'sse client connection quota exceeded');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_total_quota
BEFORE INSERT ON subscriptions
WHEN (SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id) >= 20
BEGIN
  SELECT RAISE(ABORT, 'subscription total quota exceeded');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_active_insert_quota
BEFORE INSERT ON subscriptions
WHEN NEW.active = 1 AND (
  SELECT COUNT(*) FROM subscriptions WHERE client_id = NEW.client_id AND active = 1
) >= 10
BEGIN
  SELECT RAISE(ABORT, 'subscription active quota exceeded');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_active_update_quota
BEFORE UPDATE OF active, client_id ON subscriptions
WHEN NEW.active = 1
 AND (OLD.active != 1 OR OLD.client_id != NEW.client_id)
 AND (
   SELECT COUNT(*) FROM subscriptions
    WHERE client_id = NEW.client_id AND active = 1 AND id != OLD.id
 ) >= 10
BEGIN
  SELECT RAISE(ABORT, 'subscription active quota exceeded');
END;
