# Extraction nav badges + eligible-due drain (2026-08-18)

## Summary

Public Trends showed a red **Extraction Halted** card while `autopilot_halt` was ok, because `/api/health` review-backlog counts unhid a banner in `<main>` for everyone.  Eligible filings waited for the next UTC day tick or a 150-count threshold.

Owner ruling: there is no halt/backlog card on Trends or Trades — not for admins either.  Acknowledge Halt is not a product.  Eligible drain is the unblocker.

This change:

- Removes `#extractIncidentBanner` from `<main>`.
- Gives admins iOS-style red nav badges: Review Queue = unresolved count; Admin = a real autopilot halt / stalled extract only.
- Shows fail-closed auth/spend as Admin status text only.  No Acknowledge Halt control on Trends, nav, or Admin.
- Does not auto-ack or clear the current auth latch.  Does not spendy-resume.
- Starts a run when **one** selector-eligible-due doc exists (attempts remaining, next_attempt due, raw bytes, not suppressed, not skip-kind, no primary/manual tx).  Threshold is 1, not 150.  Daily UTC is catch-up only.  `minIntervalMinutes` does not park due-now work.
- Keeps paid `idleShortCircuit` on; the idle probe now sees eligible-due review rows.

## Files changed

- `app/src/ui/dashboardHtml.ts` — no Trends/Trades card; nav badges; Admin status text only
- `app/src/extraction/autopilot.ts` — `countEligibleDueDocs` + `eligible` trigger capped at 1 doc
- `app/src/extraction/reviewQueueHealth.ts` — shared terminal-reason SQL
- `app/src/deno/scheduledTick.ts` — `eligibleReview` on the idle probe
- Tests next to the dashboard, autopilot, and scheduled-tick suites

## Verification

```bash
cd app && npm run typecheck && npm test
```

After deploy: trial or admin on `/?view=trends` must not show a red extract card.  Admins see Review / Admin badges in the top nav.  Fail-closed auth/spend is Admin status text only.  One selector-eligible-due House PTR claims on the next minute tick via the cheap-first path already on main (PR 1985).

## Follow-ups

- Do not bulk-resolve the remaining suppressed/terminal `review_queue` rows.
- Keepout: `grok/extract-halt-banner` 0.55 deterministic publish bar; extract/#1959 executive scanned_pdf OCR.
- Do not raise the OpenRouter Files daily spend cap.
