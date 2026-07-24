# 2026-07-23 — Stale effort reconcile + terra/luna rate-card + webhook Sentry noise

## Summary

CURSOR cloud session asked to resolve in-progress effort-log rows and GitHub issues.
GitHub Issues API returned 403 for this integration; open PR list was empty. Audit of
`docs/EFFORT-LOG.md` showed most "OPEN/IN PROGRESS" rows were already merged (#670, #674,
#774–#776, #781, #849, #854, etc.). Remaining actionable code:

1. Replace leftover `openrouter-dummy` OpenRouter rows for `openai/gpt-5.6-terra` and
   `openai/gpt-5.6-luna` with verified OpenAI passthrough rates (same class of bug as #674).
2. Stop `Sentry.captureException` on expected `DeliveryRetryError` / `IngestRetryError`
   (CONGRESS-TRADE-J webhook-retry storm).
3. Reconcile the effort log Active / In Progress board + STATUS snapshot.

## Files changed

- `app/src/extraction/benchmarkMetrics.ts`
- `app/src/extraction/__tests__/benchmarkMetrics.test.ts`
- `app/src/index.ts`
- `app/src/delivery/__tests__/queueRetry.test.ts`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `docs/rollouts/2026-07-23-stale-effort-terra-luna-webhook-sentry.md`

## Verification

```bash
cd app && npm run typecheck
cd app && npm test -- src/extraction/__tests__/benchmarkMetrics.test.ts src/delivery/__tests__/queueRetry.test.ts
cd app && npm test
```

## Follow-ups

- Owner/ops: R2 enablement (CONGRESS-TRADE-19), watcher-cron check-in (CONGRESS-TRADE-1),
  OpenRouter/Mistral key limits, Deno House/Executive parity (CODEX lane).
- Owner product decisions: analytics premium-only; public subscription login requirement.
- GitHub Issues token scope: restore issues:read so fleet can close effort-issue mirrors.
