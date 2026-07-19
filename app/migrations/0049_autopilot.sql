-- 0049_autopilot.sql
-- Backlog-autopilot run receipts + daily USD spend meter.
--
-- autopilot_runs: one row per autopilot run (cron-started, queue-driven).
--   status: running | completed | halted | halt_acknowledged.
--   A 'halted' row (error-class kill-switch, stalled consumer, or enqueue
--   failure) BLOCKS new runs until POST /api/admin/autopilot/acknowledge
--   flips it to 'halt_acknowledged' — errors are for seeing and
--   understanding, not spending through.
--   JSON receipt columns: outcomes (per-doc), error_class_counts,
--   sample_errors (one bounded sample per class), skip_reasons.
--
-- autopilot_budget: per-UTC-day USD spend meter in integer micro-USD
-- (1 USD = 1_000_000), reserved via a guarded UPDATE before each doc and
-- settled to rate-card-priced actual usage afterwards. Shared by every run
-- that day (AUTOPILOT_DAILY_USD_BUDGET, default 5.00).
--
-- Mirrored idempotently in POST /api/admin/migrate (src/admin/migrations.ts).

CREATE TABLE IF NOT EXISTS autopilot_runs (
  id                  TEXT PRIMARY KEY,
  status              TEXT NOT NULL DEFAULT 'running',
  run_trigger         TEXT NOT NULL,
  revision            INTEGER NOT NULL DEFAULT 1,
  backlog_before      INTEGER,
  docs_attempted      INTEGER NOT NULL DEFAULT 0,
  docs_published      INTEGER NOT NULL DEFAULT 0,
  docs_deferred       INTEGER NOT NULL DEFAULT 0,
  spend_microusd      INTEGER NOT NULL DEFAULT 0,
  budget_microusd     INTEGER NOT NULL DEFAULT 0,
  error_class_counts  TEXT,
  sample_errors       TEXT,
  outcomes            TEXT,
  skip_reasons        TEXT,
  halt_reason         TEXT,
  acknowledged_at     TEXT,
  acknowledged_by     TEXT,
  started_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  finished_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_autopilot_runs_status
  ON autopilot_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS autopilot_budget (
  day            TEXT PRIMARY KEY,
  spend_microusd INTEGER NOT NULL DEFAULT 0
);
