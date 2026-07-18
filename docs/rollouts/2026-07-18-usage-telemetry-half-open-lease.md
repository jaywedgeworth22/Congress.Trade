# Usage Telemetry Half-Open Lease

## Summary

The Usage Monitor outage circuit now permits only one half-open recovery probe
across Worker isolates. After the KV cooldown expires, receiver configuration is
resolved first, then one contender atomically claims the singleton D1 lease and
persists a KV probe-in-flight gate before contacting Usage Monitor. Receiver
headers, response-body parsing, and response validation share one abort
deadline. Unavailable or malformed breaker state fails closed.

R2 remains the only new-event durable fallback. Queue and DLQ messages are
acknowledged only after receiver acceptance, a deterministic per-event reject,
or exact-event R2 persistence. Capacity or R2 failure causes retry. Terminal
receiver rejects and malformed R2 bytes are copied to a quarantine prefix
before the outbox object is deleted; quarantine failure preserves the source.
Transient authentication, rate-limit, server, timeout, and malformed-success
responses retain their durable event and contribute to outage backoff.

PR #587 originally merged only the migration, readiness, type, and queue-boundary
portion because its conflict-resolution merge omitted the reviewed telemetry
core and tests. The corrective follow-up restores that core on exact current
`main` and reconciles it with the newer terminal-event behavior from PR #584.

## Files changed

- `app/migrations/0046_usage_telemetry_probe_lease.sql` — singleton lease row.
- `app/src/admin/migrations.ts` — idempotent production migration mirror.
- `app/src/shared/readiness.ts` — requires the lease table before readiness.
- `app/src/shared/types.ts` and `app/.dev.vars.example` — timeout and lease
  controls with safe defaults.
- `app/src/index.ts` — queue/DLQ durable-ACK and terminal-event handling.
- `app/src/shared/thirdPartyTelemetry.ts` — fail-closed breaker, lease claim,
  complete receiver deadline, R2 capacity enforcement, and poison quarantine.
- Telemetry, queue, readiness, and migration tests — concurrency, stale-state,
  outage, capacity, timeout, quarantine, and schema regressions.

## Verification

- Focused telemetry, queue, readiness, and migration suites: 89 tests passed.
- `npm run typecheck`: passed.
- Changed-file ESLint: zero errors.
- Serialized full backend suite: 143 files / 1,500 tests passed.
- `git diff --check`: passed.

## Deployment and follow-ups

- Merge only after the corrective backend PR and independent current-main PWA
  repair both report green hosted checks.
- Deploy merged `main` through `bash app/scripts/ship.sh`; never apply migration
  0046 with remote Wrangler migrations.
- Verify the exact production revision plus `/api/health` and `/api/ready`, with
  `schema: true` and no missing readiness probes.
- Keep the effort row and Slack KEEPOUT active until migration, deploy, and live
  health receipts are recorded.
