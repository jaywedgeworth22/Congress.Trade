-- 0001_init.sql
-- Initial schema for congress-feed (STOCK Act disclosure ingestion + delivery).
-- Target: Cloudflare D1 (SQLite).

CREATE TABLE IF NOT EXISTS filers (
  bioguide_id TEXT PRIMARY KEY,
  chamber     TEXT,
  full_name   TEXT,
  party       TEXT,
  state       TEXT,
  district    TEXT,
  committees  TEXT
);

CREATE TABLE IF NOT EXISTS filings (
  doc_id            TEXT PRIMARY KEY,
  chamber           TEXT,
  filer_id          TEXT,
  filing_type       TEXT,
  filed_date        TEXT,
  source_url        TEXT,
  raw_object_key    TEXT,
  ingest_status     TEXT,
  doc_kind          TEXT,
  extractor         TEXT,
  model_version     TEXT,
  confidence        REAL,
  first_seen_at     TEXT,
  source_updated_at TEXT,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_filings_status ON filings (ingest_status);
CREATE INDEX IF NOT EXISTS idx_filings_filer  ON filings (filer_id);

CREATE TABLE IF NOT EXISTS transactions (
  id                 TEXT PRIMARY KEY,
  doc_id             TEXT,
  filer_id           TEXT,
  tx_date            TEXT,
  owner              TEXT,
  asset_name         TEXT,
  ticker             TEXT,
  asset_type         TEXT,
  tx_type            TEXT,
  amount_min         INTEGER,
  amount_max         INTEGER,
  is_option          INTEGER,
  cap_gains_over_200 INTEGER,
  raw_text           TEXT,
  confidence         REAL,
  source             TEXT NOT NULL DEFAULT 'primary', -- primary|seed_dataset
  created_at         TEXT,
  cursor_seq         INTEGER
);

CREATE TABLE IF NOT EXISTS tx_cursor_seq (
  seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_transactions_cursor
AFTER INSERT ON transactions
FOR EACH ROW
WHEN NEW.cursor_seq IS NULL
BEGIN
  INSERT INTO tx_cursor_seq (tx_id) VALUES (NEW.id);
  UPDATE transactions
     SET cursor_seq = (SELECT seq FROM tx_cursor_seq WHERE tx_id = NEW.id)
   WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_tx_cursor ON transactions (cursor_seq);
CREATE INDEX IF NOT EXISTS idx_tx_ticker ON transactions (ticker);
CREATE INDEX IF NOT EXISTS idx_tx_filer  ON transactions (filer_id);
CREATE INDEX IF NOT EXISTS idx_tx_date   ON transactions (tx_date);

CREATE TABLE IF NOT EXISTS securities_master (
  ticker  TEXT PRIMARY KEY,
  name    TEXT,
  aliases TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id         TEXT PRIMARY KEY,
  client_id  TEXT,
  delivery   TEXT,
  target_url TEXT,
  secret     TEXT,
  filters    TEXT,
  cursor     INTEGER,
  active     INTEGER,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions (active);

CREATE TABLE IF NOT EXISTS deliveries (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT,
  tx_id           TEXT,
  status          TEXT,
  attempts        INTEGER,
  last_error      TEXT,
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_sub    ON deliveries (subscription_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries (status);

CREATE TABLE IF NOT EXISTS poll_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  schedule        TEXT,
  aggressive_mode INTEGER,
  updated_at      TEXT
);

INSERT OR IGNORE INTO poll_config (id, schedule, aggressive_mode, updated_at)
VALUES (
  1,
  '[{"daysOfWeek":[1,2,3,4,5],"startHourET":8,"endHourET":19,"intervalSec":300},{"daysOfWeek":[1,2,3,4,5],"startHourET":19,"endHourET":24,"intervalSec":1200},{"daysOfWeek":[1,2,3,4,5],"startHourET":0,"endHourET":8,"intervalSec":1200},{"daysOfWeek":[0,6],"startHourET":0,"endHourET":24,"intervalSec":3600}]',
  0,
  '1970-01-01T00:00:00.000Z'
);

CREATE TABLE IF NOT EXISTS review_queue (
  doc_id     TEXT PRIMARY KEY,
  reason     TEXT,
  payload    TEXT,
  created_at TEXT,
  resolved   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_review_resolved ON review_queue (resolved);

-- ingest_log — per-poll record for measuring real refresh cadence.
CREATE TABLE IF NOT EXISTS ingest_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,               -- 'house' | 'senate'
  polled_at     TEXT NOT NULL,               -- ISO when poll ran
  new_count     INTEGER NOT NULL DEFAULT 0,  -- # new filings discovered this poll
  first_seen_at TEXT                         -- ISO earliest first_seen in batch
);
CREATE INDEX IF NOT EXISTS idx_ingest_log_source ON ingest_log (source, polled_at);
