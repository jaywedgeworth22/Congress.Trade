# Retire GPT-4o from disclosure extraction

## Summary

Congress.Trade no longer offers or accepts GPT-4o for new scanned-disclosure
reads. GPT-5.6 Terra is the default OpenAI production tier with medium
reasoning, Luna uses low reasoning for lower-cost first passes, and Sol uses
high reasoning for difficult-scan adjudication. All three use the Responses API
with original-detail PDF input and strict structured output.

The retirement applies to curated bake-offs, review re-reads, durable benchmark
runs and saved lineups, manual agreement reprocessing, autonomous agreement
configuration, and OpenAI batch submission. Stale agreement configuration in
Wrangler or Infisical is upgraded from the GPT-4o family to Terra at runtime so
it cannot silently keep making new GPT-4o calls.

Historical GPT-4o extraction runs and batch results remain readable. The old
rate card remains so their saved usage can still be priced. This change does not
replace the primary Gemini extraction path; it changes the OpenAI disclosure
candidate and agreement paths.

## Files changed

- `app/src/extraction/bakeoff.ts` — GPT-4o retirement guard, GPT-5.6 reasoning
  profiles, curated candidates, and Responses request settings.
- `app/src/extraction/batchExtract.ts` — GPT-5.6 Batch requests now use
  `/v1/responses`; polling decodes both Responses and historical Chat
  Completions results.
- `app/src/extraction/agreement.ts` — stale active GPT-4o configuration upgrades
  to Terra without rewriting historical records.
- `app/src/admin/routes.ts` — Terra batch default and rejection of new GPT-4o
  bake-off, batch, and agreement requests.
- `app/src/benchmark/providerAccess.ts`, `app/src/ui/dashboardHtml.ts`,
  `app/wrangler.toml`, and `app/.dev.vars.example` — current catalogs, controls,
  and fallback configuration no longer include GPT-4o.
- Focused tests under `app/src/**/__tests__/` cover active retirement,
  reasoning profiles, Responses Batch shape/decoding, and historical
  compatibility.

## Verification

From `app/`:

```bash
npm run typecheck
npm run lint -- --quiet
npm test
```

No paid provider call is part of local or preview verification. After an
isolated preview deploy, verify health and confirm the admin UI offers only
Terra, Luna, and Sol in the OpenAI disclosure choices.

## Follow-ups

- A no-generation `/v1/models` catalog check on 2026-07-15 confirmed that the
  production OpenAI project can access Terra, Luna, and Sol. No paid inference
  was used for the access check.
- The malformed source-owned `AGREEMENT_HOUSE_MODEL_A=mistral-ocr-latest`
  override was deleted from Infisical so House inherits the valid global
  `mistral:mistral-ocr-latest` setting. After this release, the Wrangler fallback
  changes the global OpenAI agreement leg from GPT-4o to Terra.
- Do not remove GPT-4o historical rate-card or result-decoding support while
  saved GPT-4o runs or already-submitted batch jobs remain in storage.
