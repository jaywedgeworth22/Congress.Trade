-- Atomic daily D1 row counters. The UPSERT in shared/d1Budget.ts serializes
-- concurrent Worker-isolate flushes so usage cannot be lost by KV RMW races.
CREATE TABLE IF NOT EXISTS d1_budget (
  day          TEXT PRIMARY KEY,
  rows_read    INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0
);
