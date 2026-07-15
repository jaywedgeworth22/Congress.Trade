# Local production sweep and disclosure-reader decision

## Summary

The owner requested that completed Congress.Trade improvements never remain
local-only. A read-only audit covered 32 worktrees and every local branch against
fetched `origin/main`. It found one substantive unpublished change:
`b9f5c72`, which retires GPT-4o from new disclosure reads. All other apparent
ahead commits were merged, squash-equivalent, superseded, stale documentation,
or active uncommitted work owned by another agent.

This integration ports that retirement onto current `main` and preserves two
fixes from closed, unmerged PR #410: cached extraction rows are decoded from the
actual flat-array storage shape and fail soft before migration, while benchmark
paths bypass that cache so latency, usage, and cost are freshly measured.

A no-generation OpenAI model-catalog request confirmed that the production
project can access GPT-5.6 Terra, Luna, and Sol. No paid model inference ran.
The live House lineup was verified as
`mistral:mistral-ocr-latest`; the malformed unprefixed value is no longer the
effective setting, so no unrelated Infisical source was changed.

## Batch economics

OpenAI Batch charges 50% less than the same synchronous API requests and can
take up to 24 hours. Congress.Trade should use it for historical backfills,
bulk reprocessing, and evaluations, but not for live primary reads. The same
offline-first rule applies to other provider batch products: cost savings do not
justify delaying a live ingestion path.

## Primary-reader decision

No checked-in benchmark proves a quality winner across representative House,
Senate, and Executive disclosures. The prior production run proves availability,
not comparative accuracy: Mistral and GPT-4o completed while GPT-5.6 lacked
access, Gemini lacked credits, and Anthropic reached its account cap.

The provider-neutral provisional architecture is:

1. Keep deterministic text extraction first.
2. Use Mistral OCR 4 document annotations as the provisional synchronous reader
   for image-only disclosures because it is purpose-built for structured OCR,
   supports low-quality and handwritten sources, is already adapted in this
   codebase, and costs $5 per 1,000 annotated pages at current list price.
3. Escalate low-confidence, faint, handwritten, rotated, crossed-out, or
   irregular-table pages to an independent semantic reader selected by a
   stratified benchmark among GPT-5.6 Terra, Gemini, and Claude.
4. Reserve GPT-5.6 Sol for disagreement/critical adjudication; unresolved
   cross-outs remain human-review conditions.

This release does not switch the live Gemini primary. Promotion requires a
representative human-ground-truth benchmark scored by worst-stratum row F1,
critical-field exactness, hallucination/abstention behavior, failure rate,
latency, and measured cost.

## Files changed

- `app/src/extraction/bakeoff.ts` — GPT-4o retirement, GPT-5.6 reasoning and
  original-detail inputs, correct fail-soft cache reuse, benchmark bypass option.
- `app/src/extraction/batchExtract.ts` — GPT-5.6 Responses Batch requests and
  robust terminal result decoding.
- `app/src/admin/routes.ts` — active GPT-4o rejection and fresh benchmark calls.
- `app/src/extraction/agreement.ts`, `app/wrangler.toml` — stale GPT-4o upgrade
  and Terra agreement fallback.
- Benchmark/extraction/admin/UI tests and disclosure-model documentation.

## Verification

Before merge:

```bash
cd app
npm run typecheck
npm run lint -- --quiet
npm test
```

Then deploy the isolated preview and verify health, schema, admin fail-closed
behavior, the OpenAI model catalog, the disclosure model choices, and that no
new GPT-4o request path remains.

After protected merge, deploy the exact fetched `origin/main` through the
canonical production path and verify the Worker release SHA, health/schema,
all three chamber lineups, and GPT-4o absence from new disclosure controls.

Completed pre-merge verification:

- `npm ci`: 234 packages audited, zero vulnerabilities.
- TypeScript and ESLint quiet passed.
- Serialized full suite: 127 files / 1,274 tests passed.
- Focused integration suite: 13 files / 264 tests passed after one corrected
  assertion; final cache file rerun passed 40/40.
- The preview wrapper's redundant full-suite run passed 126/127 files and
  1,273/1,274 tests; the sole 5-second bootstrap timeout occurred at system
  load above 100. Its immediate serialized rerun passed 16/16, matching the
  earlier complete green suite.
- Isolated preview Worker version
  `f1c4f3dd-36c7-4832-a1ce-146c0c9473f1` is live at
  `https://congress-trade-preview.jaywedgeworth22.workers.dev`. Health is HTTP
  200 with `ok/db/schema=true` and `missing=[]`; the UI is HTTP 200 and contains
  Terra/Luna/Sol with no active GPT-4o choice; the admin model-access endpoint
  fails closed with HTTP 401 when unauthenticated.

## Follow-ups

- Run the stratified paid benchmark only with a separately bounded budget and
  restored provider funding/caps; do not infer quality from availability.
- If Mistral becomes primary, do not reuse Mistral as an independent agreement
  voter. Reuse its primary result or select two genuinely independent vendors.
- Preserve historical GPT-4o result decoding and pricing while saved runs or
  submitted jobs still reference it.
