-- 0049_resource_governors.sql
-- Hard resource governors (owner mandate 2026-07-18: no LLM spend spikes, no
-- D1 write spikes, no outbound storms triggered by peer-site outages).
--
--   llm_spend               per-day, per-provider metered LLM dollars
--                           (provider-reported cost when available, else the
--                           shared benchmark rate card). Enforced fail-closed
--                           by src/shared/llmSpend.ts inside the provider-call
--                           choke point (runCandidateOnDoc + fetchWithRetry).
--   d1_write_quarantine     one marker row per governed write-batch truncation
--                           so a write storm degrades to bounded batches with
--                           an auditable remainder (src/shared/d1Budget.ts).
--   delivery_target_circuit per-target outbound circuit breaker state for
--                           webhook + cross-app deliveries
--                           (src/delivery/targetCircuit.ts).

CREATE TABLE IF NOT EXISTS llm_spend (
  day        TEXT NOT NULL,
  provider   TEXT NOT NULL,
  usd        REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, provider)
);

CREATE TABLE IF NOT EXISTS d1_write_quarantine (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  writer     TEXT NOT NULL,
  day        TEXT NOT NULL,
  dropped    INTEGER NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_d1_write_quarantine_day ON d1_write_quarantine (day, writer);

CREATE TABLE IF NOT EXISTS delivery_target_circuit (
  target_key           TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  open_until           TEXT,
  failures_day         TEXT,
  failures_today       INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  updated_at           TEXT NOT NULL
);
