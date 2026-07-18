# Public UI Render Recovery

## Summary

The production dashboard rendered only its navigation because `#view-trends` and every later view were parsed as descendants of the hidden `#view-feed` panel. Commit `ba10898` removed the Trades panel's closing `</section>` during a UI merge. This change restores the missing close and adds a DOM-structure regression test so syntax-only checks cannot miss nested primary views again.

## Files changed

- `app/src/ui/dashboardHtml.ts` — close `#view-feed` before the Trends panel.
- `app/src/ui/__tests__/dashboardHtml.test.ts` — parse the emitted HTML and require the five primary panels to be direct children of `main`.
- `docs/EFFORT-LOG.md` — record incident ownership and rollout state.

## Verification

- `npm run typecheck`
- `npm test -- --run src/ui/__tests__/dashboardHtml.test.ts` — 83/83 passed.
- `npm test -- --maxWorkers=1 --reporter=dot` — 135 files / 1,421 tests passed.
- Browser reproduction before the fix showed `#view-trends` nested inside hidden `#view-feed`, with a zero-height main surface.
- Production browser verification after deployment must confirm visible Trends content, working Trends/Trades/Alerts navigation, no relevant console errors, and healthy `/api/health` plus transactions API responses.

## Follow-ups

- Keep the DOM-parent regression in the required UI test suite.
- Record the merged commit, Worker version, and live browser evidence here after production rollout.
