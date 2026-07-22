-- Bounded hard-governor reads plus durable autopilot reservation identity.

CREATE TABLE IF NOT EXISTS llm_spend_settlement_totals (
  day        TEXT NOT NULL,
  provider   TEXT NOT NULL,
  usd        REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, provider)
);

INSERT INTO llm_spend_settlement_totals (day, provider, usd, updated_at)
SELECT day, provider, SUM(usd), MAX(created_at)
  FROM llm_spend_settlements
 GROUP BY day, provider
ON CONFLICT(day, provider) DO UPDATE SET
  usd = excluded.usd,
  updated_at = excluded.updated_at;

CREATE TRIGGER IF NOT EXISTS trg_llm_spend_settlement_projection
AFTER INSERT ON llm_spend_settlements
BEGIN
  INSERT INTO llm_spend_settlement_totals (day, provider, usd, updated_at)
  VALUES (NEW.day, NEW.provider, NEW.usd, NEW.created_at)
  ON CONFLICT(day, provider) DO UPDATE SET
    usd = usd + excluded.usd,
    updated_at = excluded.updated_at;
END;

CREATE TABLE IF NOT EXISTS autopilot_budget_reservations (
  reservation_id    TEXT PRIMARY KEY,
  day               TEXT NOT NULL,
  reserved_microusd INTEGER NOT NULL CHECK (reserved_microusd >= 0),
  actual_microusd   INTEGER CHECK (actual_microusd >= 0),
  cap_microusd      INTEGER NOT NULL CHECK (cap_microusd >= 0),
  status            TEXT NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved', 'completed', 'aborted', 'failed')),
  created_at        TEXT NOT NULL,
  settled_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_autopilot_budget_reservations_day_status
  ON autopilot_budget_reservations(day, status);

CREATE TRIGGER IF NOT EXISTS trg_autopilot_budget_reserve
AFTER INSERT ON autopilot_budget_reservations
BEGIN
  INSERT OR IGNORE INTO autopilot_budget (day, spend_microusd)
  VALUES (NEW.day, 0);
  UPDATE autopilot_budget
     SET spend_microusd = spend_microusd + NEW.reserved_microusd
   WHERE day = NEW.day
     AND spend_microusd + NEW.reserved_microusd <= NEW.cap_microusd;
  SELECT CASE WHEN changes() = 0
    THEN RAISE(ABORT, 'autopilot budget exhausted') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_autopilot_budget_reservation_settle
AFTER UPDATE OF actual_microusd, status ON autopilot_budget_reservations
WHEN OLD.status = 'reserved' AND NEW.status <> 'reserved'
BEGIN
  UPDATE autopilot_budget
     SET spend_microusd = MAX(
       spend_microusd + NEW.actual_microusd - NEW.reserved_microusd,
       0
     )
   WHERE day = NEW.day;
END;
