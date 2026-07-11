-- 0032_llm_budget.sql
-- Daily budget guardrail for agreement/cascade LLM candidate doc-reads (one
-- model reading one doc = 1 read). Autonomous cascade only -- the operator
-- /agreement-reprocess endpoint stays uncapped. One row per UTC calendar day;
-- `reads` is incremented atomically (INSERT..ON CONFLICT / guarded UPDATE) by
-- reserveLlmBudget in src/extraction/agreement.ts before each tier's reads.
-- Mirrored idempotently in POST /api/admin/migrate (src/admin/routes.ts).

CREATE TABLE IF NOT EXISTS llm_budget (
  day   TEXT PRIMARY KEY,
  reads INTEGER NOT NULL DEFAULT 0
);
