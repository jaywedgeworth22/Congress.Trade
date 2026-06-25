-- 0015_extraction_runs.sql
-- Per-document, per-model extraction results. Captures every model's reading of
-- a filing — for the admin review/model-comparison dashboard and for later
-- learning (which model reads which document best). Written by the bake-off
-- endpoint (kind='bakeoff') and, going forward, the production extractor
-- (kind='production'). Additive; LEFT JOIN'd on read so it's safe to ship empty.

CREATE TABLE IF NOT EXISTS extraction_runs (
  id             TEXT PRIMARY KEY,      -- uuid
  batch_id       TEXT,                  -- groups one bake-off invocation (null for production)
  doc_id         TEXT NOT NULL,
  provider       TEXT NOT NULL,         -- gemini | openai | anthropic | mistral | xai
  model          TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'bakeoff',  -- 'bakeoff' | 'production'
  ok             INTEGER NOT NULL DEFAULT 0,        -- 1 = parsed cleanly
  error          TEXT,                  -- error message when ok=0
  row_count      INTEGER NOT NULL DEFAULT 0,
  latency_ms     INTEGER,
  avg_confidence REAL,                  -- mean per-row extractor confidence [0,1]
  result_json    TEXT,                  -- the extracted rows (ParsedTx[]) as JSON, for review/learning
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_doc     ON extraction_runs (doc_id);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_batch   ON extraction_runs (batch_id);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_created ON extraction_runs (created_at);
