# Review-queue publish autonomy (era-first + soft-agree)

**Date:** 2026-07-27  
**Agent:** CURSOR  
**Branch:** `cursor/review-queue-publish-autonomy-b37c`

## Summary

Production latency probes were matching ~0 disclosures partly because many
filings sat unresolved in the review queue (vision confidence cap → review;
autonomy then burned free-tier budget on **historical** 2022 typed docs while
current-era selectable slots were empty/claimed). Agreement/admin publish also
never seeded `trade_latency_candidates`, so even successful review publishes
did not feed the latency scoreboard.

This change makes autonomous publish prefer **timely, cheap, already-agreed**
work:

1. **Current-era-only by default** for both the agreement cron backstop and
   backlog autopilot (`AGREEMENT_INCLUDE_HISTORICAL` /
   `AUTOPILOT_INCLUDE_HISTORICAL`, default off). Historical drain is opt-in.
2. Agreement selector now matches autopilot ordering: `DOC_CLASS_ORDER_SQL` +
   era + oldest-first (was `created_at ASC` only).
3. **Soft-agree** from stored multi-vendor `extraction_runs` before spending
   LLM budget / an agreement attempt (`AGREEMENT_STORED_AGREE_ENABLED`, default
   on). Empty×empty is not agreement.
4. **`recordTradeLatencyCandidates`** on agreement finalizePublish and admin
   confirm (primary) so review-path publishes enter the latency probe set.

## Files changed

- `app/src/extraction/agreement.ts` — era filter, soft-agree, latency seed
- `app/src/extraction/autopilot.ts` — `includeHistorical` knob + hard era filter
- `app/src/extraction/docClassifier.ts` — shared `currentEraStart`
- `app/src/admin/routes.ts` — tunables registry + confirm latency seed
- `app/src/extraction/__tests__/storedAgree.test.ts` (+ autopilot/agreement tests)
- `docs/EFFORT-LOG.md`, this rollout note

## Verification

```bash
cd app && npm run typecheck && npm test
```

Focused: storedAgree, agreementAutopublish, autopilot era-filter tests.

## Ops follow-ups (Infisical)

Leave defaults unless draining history intentionally:

- `AGREEMENT_INCLUDE_HISTORICAL` unset/false
- `AUTOPILOT_INCLUDE_HISTORICAL` unset/false
- `AGREEMENT_STORED_AGREE_ENABLED` unset/true (default on)
- Optional later: set historical flags true only after current-era backlog is
  healthy

## Follow-ups

- FMP account suspended still blocks FMP latency matches (owner/billing).
- Soft-agree only helps docs that already have multi-vendor stored reads;
  cascade still owns first-time vision filings.
- Consider a one-shot admin soft-agree drain over the small stored-agree
  backlog once deployed.
