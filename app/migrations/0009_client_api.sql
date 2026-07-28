-- 0009_client_api.sql
-- Backend-owned state for the shared SwiftUI client API.

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id               TEXT PRIMARY KEY,
  saved_filters         TEXT NOT NULL DEFAULT '{}',
  watchlist             TEXT NOT NULL DEFAULT '[]',
  notification_settings TEXT NOT NULL DEFAULT '{}',
  default_window        TEXT,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_commands (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL,
  idempotency_key TEXT,
  payload         TEXT NOT NULL DEFAULT '{}',
  result          TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_commands_user_idempotency
  ON client_commands (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_client_commands_user_created
  ON client_commands (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_commands_status
  ON client_commands (status);
