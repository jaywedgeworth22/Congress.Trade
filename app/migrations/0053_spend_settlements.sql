-- Lease-independent, idempotent accounting receipts.
--
-- Paid provider responses may arrive after a durable-queue lease is lost. The
-- stale worker must remain fenced from every product side effect, but it still
-- owns the obligation to record the charge. Immutable response/attempt keyed
-- settlements make that one narrow write replay-safe.

CREATE TABLE IF NOT EXISTS llm_spend_settlements (
  settlement_id        TEXT PRIMARY KEY,
  provider             TEXT NOT NULL,
  provider_response_id TEXT,
  attempt_id           TEXT NOT NULL,
  day                  TEXT NOT NULL,
  occurred_at          TEXT NOT NULL,
  requested_model      TEXT NOT NULL,
  resolved_model       TEXT,
  doc_id                TEXT,
  usd                   REAL NOT NULL CHECK (usd > 0),
  receipt_hash          TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_spend_settlements_response
  ON llm_spend_settlements(provider, provider_response_id)
  WHERE provider_response_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_llm_spend_settlements_day_provider
  ON llm_spend_settlements(day, provider);

CREATE TABLE IF NOT EXISTS autopilot_budget_settlements (
  settlement_id    TEXT PRIMARY KEY,
  day              TEXT NOT NULL,
  reserved_microusd INTEGER NOT NULL CHECK (reserved_microusd >= 0),
  actual_microusd   INTEGER NOT NULL CHECK (actual_microusd >= 0),
  status            TEXT NOT NULL CHECK (status IN ('completed', 'aborted', 'failed')),
  created_at        TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_autopilot_budget_settlement
AFTER INSERT ON autopilot_budget_settlements
BEGIN
  UPDATE autopilot_budget
     SET spend_microusd = MAX(
       spend_microusd + NEW.actual_microusd - NEW.reserved_microusd,
       0
     )
   WHERE day = NEW.day;
END;
