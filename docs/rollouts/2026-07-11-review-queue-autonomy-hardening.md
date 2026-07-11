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
concurrent claims, and legacy/reopened queue rows. The completed lane is built
and production-live through PR #292. Its bounded one-time replay resolved seven
more filings without operator writes, then stopped with every remaining row at
the configured attempt cap.

## Files changed

- `app/src/extraction/agreement.ts` - exact material-row agreement, cascade
  safety, lease/attempt handling, guarded publish transitions, and durable
  delivery intents through the app-wide delivery outbox.
- `app/src/extraction/normalizer.ts` - revision-snapshotted, exact-row atomic
  publish/review transitions so stale extraction cannot beat a human decision.
- `app/src/extraction/consensus.ts` - fail-closed human-review consensus.
- `app/src/admin/routes.ts` - coherent extraction-run selection, reopen-state
  reset, optimistic review revisions, atomic human decisions, JSON bulk writes,
  and the production migration mirror.
- `app/src/delivery/outbox.ts` - canonical retryable transaction-to-delivery
  handoff shared by normal ingestion and review-created rows.
- `app/src/ui/dashboardHtml.ts` - preserve queued rows and material metadata
  when reviewers opt into consensus; submit the revision actually edited.
- `app/src/index.ts` - register cron lanes independently so watcher failure does
  not suppress review recovery.
- `app/migrations/0033_doc_complexity_signals.sql` through
  `0037_review_revision.sql` - collision-safe complexity, cascade/lease/replay,
  budget, human-hold/live-row, and optimistic-revision schema. Review-created
  rows use the generic `delivery_outbox` added by migration `0030`.
- `app/src/shared/transactionValue.ts`, normalizer/agreement/admin bulk writes,
  and seed backfill - one exact `est_value` rule for every transaction writer.
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

Code verification completed:

```bash
cd app
npm run typecheck
npm test -- --reporter=dot
```

- Typecheck passed.
- Combined post-#284/#264 suite passed: 104 files / 908 tests; lint passed with 0
  errors.
- Real Miniflare D1 coverage passes for stale editor/normalizer races, double
  confirms, atomic reject/unpublish/retry/hold behavior, first-pass vs review
  races, exact rollback, generic-outbox retry/backoff, `est_value`, and the
  223-row filing. That large confirmation creates all 223 durable delivery
  intents, immediately enqueues a D1-safe 80-row page, and leaves the remainder
  pending for the independent reconciler.
- Local D1 applied `0029` and the review-revision schema now numbered `0037`;
  schema inspection confirmed both
  `transactions.est_value` and `review_queue.review_revision`.
- The isolated preview ledger was reconciled from the pre-integration review
  filenames to collision-free `0033`-`0037`, alongside the app-wide
  `0030`-`0032` migrations. The normal preview deploy then reported no pending
  migrations and deployed combined Worker version
  `e1c8fb70-4291-4872-b1e2-f45f59367e6f` at
  `https://congress-trade-preview.jaywedgeworth22.workers.dev`.
- The exact-tree preview also applied merged PR #264's `0025` usage migration.
  Fresh `/api/health` returned `ok=true`, `db=true`, `schema=true`, and
  `missing=[]`; the prior review build's rendered browser QA loaded the real
  dashboard and seeded analytics without an error surface.
- Preview intentionally has no cron trigger, so autonomous scheduling proof is
  the scheduler/queue test suite rather than the URL alone.
- PR #292 merged to `main` as `f197e66da02adc053bc81f35907f9043271b585d`;
  all hosted typecheck/test, PWA typecheck/test/build, and gitleaks checks passed.
- Pre-deploy D1 Time Travel bookmark:
  `000001af-0000d458-000050a5-6a11a98a065b736d72328812598fbac8`.
- Canonical `app/scripts/ship.sh` deployed review-release Worker version
  `69b4c3cf-8543-459f-a541-623dc7cd692c` and applied `0025` plus `0029`-`0037`
  through `POST /api/admin/migrate`; no Wrangler remote migration command ran.
- PR #262 subsequently advanced `main` to `bb92250` and production to Worker
  `79945ec6-3434-472a-8d7e-76b2df1ffa04`. `f197e66` is its direct ancestor.
  A post-deploy probe returned HTTP 200 with `ok=true`, `db=true`,
  `schema=true`, and `missing=[]`.
- The one-time replay and minute scheduler reduced production from 27 pending /
  64 resolved to 20 pending / 71 resolved. Seven House filings published 13
  rows: `H-2026-20034044`, `H-2026-20034897`, `H-2026-20034790`,
  `H-2026-20034224`, `H-2026-20034952`, `H-2026-20034916`, and
  `H-2026-20034923`.
- Every autonomous publication used tier 3 with three distinct models; every
  published row was present in all three model reads. All 13 live transactions
  have non-null `est_value`, all 13 generic outbox intents exist, and all 13
  completed delivery. No manual agreement write was needed.
- The remaining 20 rows all stopped at the configured three-attempt cap as
  `agreement_cascade_unresolved`. Final state: 0 active claims, 0 stale leases,
  0 backoffs/scheduled retries, 0 suppressions, and 169/300 daily reads used.
  Two consecutive quiet samples confirmed the cascade had drained. One lease
  briefly crossed the 15-minute threshold and was reclaimed within seconds.
- Release-window model results: Mistral 71/71 successful; OpenAI 70/70;
  Anthropic 11/27. Its 16 failures were eight Senate objects rejected as invalid
  PDFs and eight malformed/truncated JSON results; the final such error occurred
  at `2026-07-11T17:00:17.977Z`, with no unsafe publication.

## Follow-ups

- Keep the remaining 20 in human review until a verified improvement exists;
  do not clear attempt stamps simply to force another identical pass.
- Make Anthropic handling chamber/content-aware: repair or re-render the eight
  Senate objects that Claude rejects as invalid PDFs, and add bounded JSON
  repair/output-size handling for the eight truncated or malformed responses.
- Add admin/health metrics for oldest pending age, eligible/deferred/claimed
  counts, budget remaining, model failure class, and terminal review state.
- A dedicated low-concurrency agreement queue and replayable agreement DLQ are
  preferable to long model calls sharing the filing-ingest queue.
