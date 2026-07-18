-- 0046_usage_telemetry_probe_lease.sql
-- A singleton, atomic half-open probe lease for the Usage Monitor circuit
-- breaker. Normal closed-circuit deliveries never touch this table; it is
-- consulted only after an open circuit's cooldown expires. The conditional
-- upsert lets exactly one Worker invocation probe the receiver while every
-- concurrent contender fails closed to the R2 outbox.

CREATE TABLE IF NOT EXISTS usage_telemetry_probe_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
