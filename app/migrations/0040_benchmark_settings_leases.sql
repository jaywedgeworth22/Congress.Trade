-- 0040_benchmark_settings_leases.sql
-- Serializes the three Infisical writes that make up one chamber's benchmark
-- A/B/C selection. The owner token makes release safe after lease takeover.

CREATE TABLE IF NOT EXISTS benchmark_settings_leases (
  chamber     TEXT PRIMARY KEY CHECK (chamber IN ('house', 'senate', 'executive')),
  owner_token TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
