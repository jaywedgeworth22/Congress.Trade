# 2026-07-05 Shared Ticker Alias Logic and SSE Client

- Summary: Migrated ticker normalizer and point-in-time score builders to use the centralized `resolveContinuousTicker` and `TICKER_RENAMES` from `congress-trading-shared`.
- Why: To fix the "Acquisition-vs-rename guard" issue where acquisitions like `ATVI` -> `MSFT` were grouped indistinguishably from true renames (e.g., `FB` -> `META`). We now ensure acquisitions are point-in-time correct and uncollapsed. Also, preparing the repo to use the shared typed `CongressTradeClient` for SSE subscriptions.
- Files:
  - `app/src/extraction/normalizer.ts`
  - `app/src/extraction/tickerNormalize.ts`
  - `app/src/export/pitScores.ts`
  - `app/src/extraction/__tests__/normalizer.test.ts`
  - `app/src/extraction/__tests__/tickerNormalize.test.ts`
- Verification: Ran `npm run typecheck` (`tsc --noEmit`), `npm test`, and `npm run build`. 
  - `npm test` initially failed due to treating acquisitions as renames; updated `normalizer.test.ts` to assert that `BRCM` (acquired by `AVGO`) remains `BRCM` instead of becoming `AVGO`. Tests now pass.
- Follow-ups: The shared repo's update is linked via local filesystem path. In a future step, it needs to be pushed, tagged, and the `package.json` dependency bumped properly.
