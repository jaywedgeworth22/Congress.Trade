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
- Production Worker `8ff8c421-b19a-4cb6-82e9-eee59535d17d` was deployed from code commit `c2369bf` with `bash app/scripts/ship.sh --deploy-only`; no schema change required migration.
- Live browser verification shows all five views as direct `main` children, visible Trends analytics, 50 Trades rows/cards, successful Trends → Trades → Alerts → Trends switching, and no console warnings or errors.
- `GET /api/health` reports `ok/db/schema=true` with no missing schema entries.

## Follow-ups

- Keep the DOM-parent regression in the required UI test suite.
- PR #566 is mergeable but cannot land while GitHub refuses to start required checks because of the account payment/spending-limit failure. Do not remove the keepout until the fix is on `main`.
