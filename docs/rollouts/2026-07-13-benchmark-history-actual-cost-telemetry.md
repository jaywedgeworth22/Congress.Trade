# Benchmark history, actual cost, and third-party telemetry

## Summary

Congress.Trade now treats model benchmarking as a durable, chamber-scoped workflow instead of a transient dashboard action. House, Senate, and Executive runs persist run summaries plus per-document/per-model results, including measured latency, provider-reported usage, actual or rate-card-derived spend, cost provenance, and coverage. The dashboard can compare prior runs, simulate the production consensus cascade, and save a validated A/B/C lineup to the matching chamber settings.

The same rollout adds end-to-end metering for outbound third-party HTTP calls. Request attempts, retries, failures, status, latency, provider usage, and exact provider spend where available are queued for `usage.jays.services`, with an R2 fallback and secret-safe metadata. Cloudflare bindings remain platform-internal and are not misreported as third-party HTTP.

Safety controls include explicit paid-run confirmation, an atomic daily call cap, retry confirmation for unknown outcomes, human-confirmed ground truth, serialized settings writes, preview read-only guards for secret/config mutation, and partial-cost labeling when a provider omits billable usage.

## Files changed

- `app/migrations/0038_benchmark_runs.sql`, `0039_benchmark_daily_call_usage.sql`, and `0040_benchmark_settings_leases.sql`: durable history/results, atomic paid-call accounting, and chamber settings leases.
- `app/src/benchmark/*`: benchmark schema, persistence, cost/latency aggregation, settings validation, rollback, and serialization.
- `app/src/admin/routes.ts` and `app/src/ui/dashboardHtml.ts`: paid run orchestration, chamber history, cascade simulation, speed/cost display, and A/B/C save controls.
- `app/src/extraction/*`: GPT-5.6/OpenAI Responses vision options, nullable unreadable-field handling, provider usage/cost capture, batch terminal-result recovery, and Executive-specific prompting.
- `app/src/shared/thirdPartyTelemetry.ts`, `app/src/index.ts`, and outbound provider modules: tracked third-party attempts, queue/R2 delivery, retry-safe measured usage, and static enforcement against untracked Worker fetches.
- `app/scripts/usage-telemetry.mjs` and `app/scripts/seed_securities.mjs`: fail-closed operator-script telemetry.
- `app/wrangler.preview.example.toml` and `app/scripts/seed-preview-fixtures.sql`: isolated, credential-free preview configuration plus synthetic House/Senate/Executive benchmark history.
- `app/docs/third-party-usage-telemetry.md`: operator contract and residual failure modes.

## Verification

- Focused benchmark/settings safety tests: 30 passed.
- Focused migration/readiness tests: 19 passed.
- Focused extraction telemetry tests: 3 passed.
- Operator-script telemetry tests: 3 passed.
- Fresh local D1 migration through `0040` and synthetic preview seed: passed; one run exists for each chamber and mixed cost coverage is represented.
- `npm run typecheck`: passed.
- `npm run lint`: passed with 0 errors (109 inherited warnings).
- Two parallel full-suite attempts reached 1,121/1,124 and 1,122/1,124 tests; every failed wall-clock-sensitive file passed immediately in isolation. The bounded single-worker confirmation passed all 122 files / 1,124 tests.
- Isolated preview deployment, browser QA, hosted CI, and production rollout receipts will be recorded here after landing.

## Follow-ups

- Do not run paid production benchmarks until the owner deliberately confirms the chamber and expected call count in the admin UI.
- Preview must remain credential-free and settings/secret mutation must remain read-only.
- Provider-reported exact cost is authoritative when present; rate-card reconstruction is labeled as derived and missing usage remains unknown rather than zero.
- Simultaneous failure of both the telemetry queue and R2 fallback remains a disclosed terminal durability gap.
- Production merge, schema application, and deploy are separate from preview verification and must be recorded explicitly when completed.
