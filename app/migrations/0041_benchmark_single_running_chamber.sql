-- 0041_benchmark_single_running_chamber.sql
-- A browser is only the orchestrator; enforce the one-active-run invariant in
-- D1 so a stale tab or direct API client cannot reserve a second paid run.

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_runs_one_running_chamber
  ON benchmark_runs (chamber)
  WHERE status = 'running';
