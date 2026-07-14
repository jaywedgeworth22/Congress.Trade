-- 0039_benchmark_daily_call_usage.sql
-- Atomic, fail-closed daily reservation ledger for paid benchmark calls.
-- A conditional UPDATE inside one D1 batch prevents concurrent admin sessions
-- from reserving beyond the configured daily ceiling.

CREATE TABLE IF NOT EXISTS benchmark_daily_call_usage (
  day TEXT PRIMARY KEY,
  reserved_calls INTEGER NOT NULL DEFAULT 0 CHECK (reserved_calls >= 0),
  updated_at TEXT NOT NULL
);
