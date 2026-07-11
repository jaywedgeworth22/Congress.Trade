# Review Queue autonomy hardening

## Summary

Production had 30 unresolved Review Queue rows. Every row had a non-null
`agreement_attempted_at`, so the one-shot backstop could not revisit any of
them. The configured second model (`openai:gpt-4o-mini`) does not accept this
pipeline's PDF payload, and the production agreement predicate compared only a
set of ticker-or-name, date, and transaction type. It did not compare amount,
owner, option/capital-gains flags, structured row details, or duplicate-row
multiplicity.

Three explicitly selected House filings were processed with
`mistral:mistral-ocr-latest` and `openai:gpt-4o` only after bounded dry runs.
They reduced the queue from 30 to 27 and inserted 36 primary rows. Visual review
against all eight pages of the official House PDFs confirmed row counts,
tickers, dates, transaction types, amount brackets, and duplicate lots. It also
exposed omitted owner and capital-gains data, so those 36 rows were corrected in
place from the official documents/queued source extraction, retaining IDs and
cursors and avoiding duplicate deliveries. `source_verified_correction` audit
receipts record the intervention.

Further production publishing was stopped when the underinclusive predicate was
confirmed. The code lane integrates the existing model-consensus/cascade work
from PR #257 and the proven model-B correction from PR #263, then hardens it to
fail closed on material disagreement, duplicate/missing lots, stale human state,
concurrent claims, and legacy/reopened queue rows.

## Files changed

- `app/src/extraction/agreement.ts` - exact material-row agreement, cascade
  safety, lease/attempt handling, and guarded publish transitions.
- `app/src/extraction/consensus.ts` - fail-closed human-review consensus.
- `app/src/admin/routes.ts` - coherent extraction-run selection, reopen-state
  reset, and production migration mirror.
- `app/src/ui/dashboardHtml.ts` - preserve queued rows and material metadata
  when reviewers opt into consensus.
- `app/src/index.ts` - register cron lanes independently so watcher failure does
  not suppress review recovery.
- `app/migrations/0030_doc_complexity_signals.sql` through
  `0032_llm_budget.sql` - collision-safe complexity, cascade/lease/replay, and
  budget schema.
- `app/wrangler.toml`, `app/.dev.vars.example`, and shared environment types -
  explicit, distinct A/B/C and retry/limit controls.
- Focused extraction/admin/UI regression tests.

## Verification

Production evidence:

- D1 before bounded passes: 91 total review rows, 30 unresolved, 61 resolved;
  all 30 unresolved rows had raw objects and `agreement_attempted_at`; none were
  eligible for the old cron.
- D1 after bounded passes: 27 unresolved.
- `H-2026-20033945`: 4 primary rows; official PDF 20033945 visually verified.
- `H-2026-20033993`: 25 primary rows including same-key duplicate lots;
  official PDF 20033993 visually verified.
- `H-2026-20034473`: 7 primary rows; official PDF 20034473 visually verified.
- All 36 corrected rows match queued/source-verified owner and capital-gains
  fields, have non-null filing status/subholding, and have row keys recomputed
  from the corrected material fields.

Code verification must include:

```bash
cd app
npm run typecheck
npm test
```

After those gates pass, deploy only through the isolated preview configuration
and verify preview health plus focused scheduled/queue tests. Preview has no cron
trigger, so a preview URL alone is not proof of autonomous scheduling.

## Follow-ups

- Production remains at 27 pending rows until the hardened code is reviewed,
  landed, migrated, and production-deployed. Do not clear stamps or run the old
  agreement endpoint over the backlog meanwhile.
- A dedicated low-concurrency agreement queue and replayable agreement DLQ are
  preferable to long model calls sharing the filing-ingest queue.
- Add admin/health metrics for oldest pending age, eligible/deferred/claimed
  counts, budget remaining, model failure class, and terminal DLQ state.
- Production merge/deploy remains separate from this local/preview lane.
