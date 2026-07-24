# 2026-07-24 — Fix executive latency candidate test (CURSOR)

## Summary
CI on `main` failed: `skips executive filings entirely` still expected no DB writes after `5264fe9` intentionally included executive (OGE) filings in latency candidates.

## Files
- `app/src/ingestion/__tests__/fmpDisclosureLatency.test.ts`
- `STATUS.md`
- `docs/rollouts/2026-07-24-fix-exec-latency-test.md`

## Verification
- Test expectation flipped to assert INSERT for executive chamber (matches production code comment).
