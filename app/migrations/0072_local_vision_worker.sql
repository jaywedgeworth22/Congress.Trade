-- 0072_local_vision_worker.sql
ALTER TABLE filings ADD COLUMN local_wait_expires_at TEXT;
CREATE TABLE IF NOT EXISTS local_worker_heartbeat (
  worker_id TEXT PRIMARY KEY,
  last_heartbeat_at TEXT NOT NULL,
  status_json TEXT
);
