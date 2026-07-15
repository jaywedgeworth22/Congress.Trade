# Per-chamber PRIMARY/FAILOVER extraction + A/B/C → C/D/E trio migration

## Summary

Introduced a fifteen-key per-chamber model-slot scheme in place of the nine
A/B/C keys:

- `AGREEMENT_{HOUSE|SENATE|EXEC}_MODEL_A` — PRIMARY live-ingestion extraction
  model (`provider:model`), consumed by the new provider-generic
  `ConfiguredVisionExtractor`.
- `AGREEMENT_{HOUSE|SENATE|EXEC}_MODEL_B` — FAILOVER extraction model, used
  only when the primary read fails.
- `AGREEMENT_{HOUSE|SENATE|EXEC}_MODEL_C/_D/_E` — the agreement trio (today's
  A/B/C semantics, unchanged behavior): tier-1 unanimous pair = C+D; tier-2/3
  = C+D+E.

`ConfiguredVisionExtractor` wraps the existing vision-LLM fallback chain
(`FallbackExtractor(geminiVision, anthropicVision)`). An unconfigured chamber
(no A key) delegates entirely to that legacy chain — today's behavior is
unchanged until an operator opts a chamber in. Once A is configured, that
choice is authoritative: a failed primary tries B (when configured and a
distinct provider); a failed/absent failover throws with both providers'
stable error strings so the orchestrator records the failure and the queue
retries. It never silently reverts to the legacy chain once explicitly
configured — no new global fallback.

The agreement cascade (`agreement.ts`) now reads C/D for the tier-1 pair and
adds E for tier-2/3, instead of A/B/C. Fail-closed behavior is unchanged:
a missing/unparsable key still resolves to `null`, leaving the doc in human
review.

## Files changed

- `app/src/extraction/agreement.ts` — `AgreementEnv` gains `_D`/`_E` fields per
  chamber; `resolveAgreementEnv` requests the new keys; `resolveModels` reads
  `_C`/`_D`; `resolveModelsWithC` adds `_E`; `parseCandidate` exported for
  reuse.
- `app/src/extraction/configuredVision.ts` (new) — `resolvePrimaryFailoverModels`
  and `ConfiguredVisionExtractor`.
- `app/src/extractors/types.ts` — `buildExtractorPipeline` wraps
  `visionLlmWithFallback` in `ConfiguredVisionExtractor` before arbitration.
- `app/src/benchmark/settings.ts` — `BENCHMARK_LINEUP_KEYS` now maps to
  `_C/_D/_E`; new `BENCHMARK_ROLE_KEYS`, `BenchmarkSelectedRoles`,
  `validateBenchmarkRoles`, `readBenchmarkRoleSettings`,
  `saveBenchmarkRoleSettings` (mirrors the lineup read/save exactly: version
  hash, provider-credential validation, fenced sequential writes, refresh,
  readback verification, rollback with a source-owned snapshot).
- `app/src/admin/routes.ts` — `config-sources` REGISTRY expanded to all
  fifteen keys per chamber; new `GET`/`PUT /benchmark/roles/:chamber`
  endpoints mirroring `/benchmark/settings/:chamber` (same auth, lease
  control, timeout, error mapping).
- `app/src/ui/dashboardHtml.ts` — trio selectors relabeled "Trio C/D/E"; new
  compact Primary/Failover row per chamber wired to the roles endpoints with
  the same expectedVersion/conflict flow and status messaging as the trio
  save.
- Tests: `benchmark/__tests__/settings.test.ts`,
  `admin/__tests__/benchmarkRoutes.test.ts`,
  `benchmark/__tests__/persistence.test.ts`,
  `extraction/__tests__/agreementCascade.test.ts`,
  `extraction/__tests__/agreementAutopublish.test.ts`,
  `extraction/__tests__/agreementLlmBudget.test.ts` (env fixtures moved to
  `_C/_D/_E`; new role read/save/conflict/rollback coverage); new
  `extraction/__tests__/configuredVision.test.ts`.

## Migration order

This is a two-step live migration — deploy first, then configure:

1. **This code deploys** reading `_C/_D/_E` for the trio. Any chamber whose
   Infisical values are still only at the old `_A/_B/_C` keys now resolves
   `null` for the trio (fail-closed): the agreement cascade pauses for that
   chamber — no publishes, no data loss, docs simply accumulate in human
   review until step 2.
2. **Operator immediately** `PUT`s the trio C/D/E with the pre-recorded live
   values below, and separately `PUT`s the new primary/failover roles A/B via
   the new `/benchmark/roles/:chamber` endpoint.
3. **Cascade resumes** on the next per-minute cron tick once C/D/E are set;
   `ConfiguredVisionExtractor` starts using A/B on the next extraction once
   set (no redeploy needed either way — both read through Infisical).

### Pre-migration live values (trio, recorded before this migration)

| Chamber   | A (legacy)              | B (legacy)              | C (legacy)                |
|-----------|--------------------------|--------------------------|----------------------------|
| House     | `mistral:mistral-ocr-latest` | `llamaparse:cost-effective` | `anthropic:claude-sonnet-4-6` |
| Senate    | `mistral:mistral-ocr-latest` | `llamaparse:fast`           | `anthropic:claude-haiku-4-5`  |
| Executive | `gemini:gemini-3.5-flash`    | `anthropic:claude-sonnet-4-6` | `openai:gpt-5.6-terra`      |

These map onto the new C/D/E trio keys unchanged (same values, new key names)
for every chamber.

### Post-migration roles (every chamber)

| Slot     | Value                        |
|----------|-------------------------------|
| Primary  | `mistral:mistral-ocr-latest`  |
| Failover | `openai:gpt-5.6-terra`        |

## Verification

- `cd app && npm run typecheck`
- `cd app && npm test` — 129 files / 1,302 tests

## Follow-ups

- Confirm the operator has run both `PUT`s (trio C/D/E, roles A/B) for all
  three chambers immediately after this deploy lands on production — until
  then the affected chamber's cascade is paused (fail-closed), not degraded.
- Watch the first cron tick after the C/D/E `PUT`s land to confirm the
  cascade resumes autonomously.
- Watch the first live-ingestion reads after the A/B `PUT`s land to confirm
  `ConfiguredVisionExtractor` is exercising the primary (not silently still
  falling through — it shouldn't, since a configured primary is
  authoritative, but this is the first production exercise of the new path).
