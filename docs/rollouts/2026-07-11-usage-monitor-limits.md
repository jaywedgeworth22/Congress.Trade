# Rollout 2026-07-11: Usage Monitor Limit Metrics

## Summary
Updated `jobs.ts` to emit a separate telemetry event with `metricType: 'limit'` to track the FMP daily call cap. This allows the Usage Monitor to understand the absolute ceiling in addition to the incremental usage over the day.

## Files Changed
- `app/src/jobs.ts` - Appended the limit telemetry event.
- `docs/EFFORT-LOG.md` - Updated to mirror completion status.

## Verification
- Verified unit and integration tests passed cleanly (0 regressions).
- Ensured typecheck success against the shared telemetry interface.
- Confirmed `fmpDailyCap` conditional successfully guards the secondary metric payload.

## Follow-ups
- Check if other integrated APIs (like Resend) expose a limit endpoint or configuration, which could also be pushed similarly in the future.
