# Coverage-adjusted provider latency comparison

## Summary

The public filing-latency scoreboard no longer treats Congress.Trade's own
discovered filings as a complete universe. It now reports timing only for
high-confidence matched overlap, while independently exposing provider-observed
rows, mature unmatched rows, and directional coverage. A 72-hour active monitor
window, 24-hour late-match grace period, 20-row minimum, and 80% coverage gates
prevent an incomplete feed from producing an "Ahead" badge or marketing claim.

## Files changed

- `app/src/ingestion/fmpDisclosureLatency.ts` — provider-observed denominator,
  maturity/grace logic, strong-match timing, coverage status.
- `app/src/analytics/routes.ts` — public coverage-adjusted latency contract.
- `app/src/ui/dashboardHtml.ts` — matched-cohort wording, unmatched-row display,
  and coverage-gated badges/alerts/pricing copy.
- `app/src/analytics/__tests__/latencySummary.test.ts` — provider-only-row
  regression case.

## Verification

From `app/`:

```bash
npm run typecheck
npm test
```

The public endpoint remains aggregate-only. It reports `comparisonBasis:
matched-overlap-only`; timing is not an overall completeness or speed claim when
`comparisonStatus` is `limited` or `insufficient`.

## Follow-ups

Provider latest endpoints are finite windows and may expose transaction rows at
a different granularity than official filings. A future reconciliation ledger
should add an official-cohort identity and explicit ambiguous/off-window states;
until then, unmatched counts are labelled provider rows rather than definitive
filing misses.
