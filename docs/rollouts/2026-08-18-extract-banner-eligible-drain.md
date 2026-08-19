# Extraction banner + eligible-due drain (2026-08-18)

## Summary

Public Trends showed a red **Extraction Halted** card while `autopilot_halt` was ok, because `/api/health` review-backlog counts unhid `#extractIncidentBanner` for everyone.  Acknowledge stayed disabled whenever extract was not halted.  The sticky Trends/Trades filter bar (`z-index: 9`, negative top margin) painted over the card.

Eligible filings (24 due, well under the 150 backlog threshold) waited for the next UTC day tick instead of the per-minute cron.

This change:

- Shows operator halt/review chrome only to admins.
- Titles the card from live state (Halted vs Review Backlog).
- Enables Acknowledge Halt only when actually halted and `canUseAdmin()`.
- Starts backlog autopilot on claimable eligible-due docs without waiting for midnight or 150.
- Keeps paid `idleShortCircuit` on, but the idle probe now sees eligible-due review rows so a quiet tick cannot skip that work.

Acknowledge is not the publish unblocker.  Eligible drain is.

## Files changed

- `app/src/ui/dashboardHtml.ts` — banner visibility, copy, ack, filter overlap CSS
- `app/src/extraction/autopilot.ts` — `countEligibleDueDocs` + `eligible` trigger
- `app/src/extraction/reviewQueueHealth.ts` — shared terminal-reason SQL
- `app/src/deno/scheduledTick.ts` — `eligibleReview` on the idle probe
- `app/src/deno/costProfile.ts` — comment only (paid still short-circuits via the probe)
- Tests next to the dashboard, autopilot, and scheduled-tick suites

## Verification

```bash
cd app && npm run typecheck && npm test
```

After deploy: a trial session on `/?view=trends` must not show the red card.  An admin halt still shows Acknowledge.  Eligible-due House PTRs should claim on the next minute tick via the cheap-first path already on main (PR 1985).

## Follow-ups

- Do not bulk-resolve the remaining suppressed/terminal `review_queue` rows.
- Keepout: extract/#1959 executive scanned_pdf OCR.
- Do not raise the OpenRouter Files daily spend cap.
