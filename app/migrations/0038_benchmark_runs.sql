-- 0038_benchmark_runs.sql
-- Durable, chamber-scoped benchmark history with per-document/per-model cost,
-- latency, output, and accuracy measurements. Monetary cost is nullable on
-- purpose: an unknown provider charge must never be silently treated as $0.
-- Mirror these statements in POST /api/admin/migrate via
-- src/benchmark/schema.ts (BENCHMARK_SCHEMA_STATEMENTS).

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  chamber TEXT NOT NULL CHECK (chamber IN ('house', 'senate', 'executive')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  requested_doc_count INTEGER NOT NULL DEFAULT 0,
  completed_doc_count INTEGER NOT NULL DEFAULT 0,
  model_count INTEGER NOT NULL DEFAULT 0,
  models_json TEXT NOT NULL DEFAULT '[]',
  request_profile_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  known_cost_usd REAL,
  cost_covered_calls INTEGER NOT NULL DEFAULT 0,
  invoked_calls INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  selected_lineup_json TEXT,
  selected_at TEXT,
  selection_error TEXT,
  selection_audit_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_chamber_started
  ON benchmark_runs (chamber, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status_started
  ON benchmark_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS benchmark_run_documents (
  run_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  ground_truth_json TEXT,
  PRIMARY KEY (run_id, doc_id),
  FOREIGN KEY (run_id) REFERENCES benchmark_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_benchmark_documents_doc
  ON benchmark_run_documents (doc_id, run_id);

CREATE TABLE IF NOT EXISTS benchmark_model_results (
  run_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  resolved_model TEXT,
  invoked INTEGER NOT NULL DEFAULT 1 CHECK (invoked IN (0, 1)),
  ok INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0, 1)),
  outcome TEXT,
  autonomous INTEGER NOT NULL DEFAULT 0 CHECK (autonomous IN (0, 1)),
  error TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  avg_confidence REAL,
  latency_ms INTEGER,
  cost_usd REAL,
  cost_source TEXT NOT NULL DEFAULT 'unknown'
    CHECK (cost_source IN ('provider_reported', 'usage_priced', 'unknown')),
  cost_detail_json TEXT,
  provider_request_id TEXT,
  usage_json TEXT,
  result_json TEXT,
  perfect_match INTEGER CHECK (perfect_match IN (0, 1) OR perfect_match IS NULL),
  true_positive INTEGER,
  false_positive INTEGER,
  false_negative INTEGER,
  started_at TEXT,
  completed_at TEXT,
  claim_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, doc_id, provider, model),
  FOREIGN KEY (run_id, doc_id)
    REFERENCES benchmark_run_documents(run_id, doc_id) ON DELETE CASCADE,
  CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CHECK (cost_usd IS NULL OR cost_usd >= 0)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_results_run_model
  ON benchmark_model_results (run_id, provider, model);
CREATE INDEX IF NOT EXISTS idx_benchmark_results_model_run
  ON benchmark_model_results (provider, model, run_id);
