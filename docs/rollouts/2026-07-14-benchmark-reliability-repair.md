# Benchmark reliability repair

## Summary

The durable House, Senate, and Executive benchmark workflow now separates provider availability from extraction quality and makes interrupted browser runs explicit. Production evidence from House run `84da721d-aa57-4bec-b34c-ba6898e9fd06` showed three different account/access failures: the current OpenAI project cannot invoke GPT-5.6 Terra/Luna/Sol, Anthropic is at its account usage cap, and Gemini has exhausted prepaid credits. GPT-4o and Mistral completed successfully, confirming that document loading and Infisical key resolution were not the shared failure.

The repair adds one provider-admission canary followed by one first-provider-response canary per remaining model, an OpenAI project-visible model-catalog preflight, saved secret-safe diagnostics, resumable/stoppable partial runs, status-fenced cancellation/completion/cell claims, successful-call latency separate from rejection latency, and deterministic rescoring from saved rows without provider calls. A local document-load failure advances the canary instead of releasing concurrent paid calls. Exact document equality remains strict; row-detection F1 now uses stable trade-row identity so optional metadata differences do not become both a false positive and false negative.

Measured cost remains based on provider-reported cost or actual metered units multiplied by a pinned rate card. Unknown coverage stays visibly unknown; it is not presented as an estimate or invoice reconciliation.

## Files changed

- `app/src/admin/routes.ts` — readiness, circuit, rescore, cancel, and concurrency-safe completion routes.
- `app/src/benchmark/persistence.ts` — deterministic unavailable cells, rescoring, split latency summaries, active-run admission, and status fences.
- `app/migrations/0041_benchmark_single_running_chamber.sql` and `app/src/benchmark/schema.ts` — one active run per chamber enforced in D1.
- `app/src/benchmark/providerAccess.ts` — cached, telemetry-tracked OpenAI model-catalog readiness.
- `app/src/benchmark/scoring.ts` — strict document match plus stable row-detection scoring.
- `app/src/extraction/bakeoff.ts` and `app/src/extraction/providerFailure.ts` — structured provider failures.
- `app/src/ui/dashboardHtml.ts` — durable history/progress, diagnostics, partial-run controls, corrected labels/denominators, and server-filtered execution.
- Corresponding focused tests under `app/src/**/__tests__/`.

Migration `0041` adds only a unique partial index over running chamber rows; existing benchmark JSON/result columns hold the new non-secret profile and diagnostics. Production schema must be applied through the canonical `POST /api/admin/migrate` path in `ship.sh`, never through remote Wrangler migrations.

## Verification

From `app/`:

```bash
npm run typecheck
npm run lint -- --quiet
npm test
git diff --check
```

Local verification completed with 126 test files / 1,243 tests, zero TypeScript or ESLint errors, clean diff checks, and a fresh local migration sequence through `0041`. A migrated-SQLite race regression also proves that a terminalized run cannot claim or insert another model/document cell.

Before production, deploy through the isolated preview path and verify:

1. House, Senate, and Executive history switch independently and persists across reloads.
2. The interrupted House run is labeled `paused / resumable`, with exact completed/pending/claimed counts.
3. `Stop and keep partial results` terminalizes only a running run and retains saved measurements.
4. OpenAI readiness excludes catalog-proven unavailable GPT-5.6 models before paid-call reservation.
5. A reload still shows the excluded model-access reasons from the saved run profile.
6. A second same-chamber start returns the existing active run and reserves zero calls.
7. A deterministic provider failure makes one canary call, then records remaining affected cells as non-invoked/unavailable; local pre-provider failures advance rather than release the canary gate.
8. Rescore changes saved comparison metrics without any provider request.
9. Simulation and lineup save exclude any model with failed/unavailable reads and require scored evidence.

After production deploy, call the authenticated rescore endpoint once for the interrupted House run and verify the saved response. This operation is D1-only and makes no provider call.

## Follow-ups

- Do not resume the interrupted paid House run automatically. The operator can retain/stop it and start a clean run after provider access or billing is repaired.
- Keep GPT-5.6 Terra/Luna/Sol as curated benchmark options, but exclude them at run time until the OpenAI project catalog reports access. GPT-4o remains the accessible control model.
- Restore Gemini credits and raise/renew the Anthropic usage limit before comparing those providers.
- GPT-5.5/GPT-5.4 remain readiness probes only; do not add them as selectable or priced candidates until project access and rate-card support are verified.
- Actual provider invoices can still differ from metered/list-price cost. Reconciliation remains a separate billing-system concern.
