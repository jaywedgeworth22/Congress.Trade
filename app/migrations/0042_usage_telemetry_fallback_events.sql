-- 0042_usage_telemetry_fallback_events.sql
-- Final local durability layer for usage.jays.services telemetry. Queue failures
-- first spill to R2 and then direct delivery; if both are unavailable, retain the
-- exact idempotent event in D1 so the scheduled fallback drain can retry later.

CREATE TABLE IF NOT EXISTS usage_telemetry_fallback_events (
  idempotency_key TEXT PRIMARY KEY,
  event_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_telemetry_fallback_events_updated
  ON usage_telemetry_fallback_events (updated_at);
