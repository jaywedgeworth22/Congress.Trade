# Telemetry half-open recovery lease

## Summary

Added a durable D1 singleton lease for half-open Usage Monitor probes. The
telemetry circuit now permits at most one receiver probe after its backoff
window, fails closed when lease coordination is unavailable, and quarantines
malformed or deterministic per-event delivery rejects instead of replaying
poison outbox entries indefinitely.

## Files changed

- `app/migrations/0046_usage_telemetry_probe_lease.sql`
- `app/src/admin/migrations.ts`
- `app/src/shared/readiness.ts`
- `app/src/shared/thirdPartyTelemetry.ts`
- `app/src/shared/types.ts`
- telemetry and readiness tests under `app/src/**/__tests__/`

## Verification

- Run `cd app && npm run typecheck`.
- Run the focused telemetry, queue, migration, and readiness Vitest suites.
- Deploy through the Coolify Actions production workflow only after explicit
  coordination; the production schema is applied by `POST /api/admin/migrate`.

## Follow-ups

- Confirm the deployed readiness response includes the probe-lease table after
  the canonical migration endpoint runs.
- Monitor Usage Monitor receiver failures, R2 quarantine writes, and probe-lease
  contention after rollout.
