# OpenAI Batch terminal settlement and usage accounting

## Summary

OpenAI Batch jobs now settle from the provider's terminal status even when the batch exposes only an error file or no result files. The poller reads distinct output and error files, rejects malformed nonblank JSONL, validates every returned `custom_id` against the submitted document set, and records expected, returned, missing, provider-error, and parsed-result counts.

Terminal result persistence and usage accounting are replay-safe. A compare-and-swap stores the winning aggregate-versus-per-result accounting plan, then a second CAS pins one exact terminal decision before any outcome-specific rows or measured events. Only that decision can finalize; retries can resume the same decision after transient storage failure. Extraction rows use deterministic identities, and database write failures leave the job retryable. Provider lifecycle timestamps and trustworthy batch-level usage survive invalid document payloads without allowing malformed results into product state. Workflow output remains bounded and excludes provider-authored document content, tokens, and credentials; its temporary response file is owner-only and deleted on exit.

New submissions carry an accounting-protocol marker. Because an unversioned job may already have emitted either the historical index-keyed family or the later document-keyed family, its measured per-result units are not re-emitted. The safe summary records `suppressed_unknown`; legacy random-id rows are reused. This conservative boundary avoids double billing without fabricating a missing historical fact. For protocol-marked jobs, measured usage must reach the Queue or R2 fallback before terminal settlement, so transient durability exhaustion can be retried.

## Files changed

- `app/src/extraction/batchExtract.ts`: terminal-state handling, output/error file retrieval, strict JSONL, bounded provider errors, optional aggregate usage, and provider lifecycle metadata.
- `app/src/admin/routes.ts`: exact identity validation, durable failure summaries, replay-safe accounting plans and extraction rows, lifecycle persistence, and retryable storage failures.
- `app/src/extraction/__tests__/batchExtract.test.ts` and `app/src/admin/__tests__/batchStatusUsage.test.ts`: terminal-file, malformed-payload, legacy replay, concurrency, persistence-failure, timing, and usage regressions.
- `.github/workflows/admin-maintenance.yml`: bounded allowlisted batch-status receipt fields.
- `app/docs/third-party-usage-telemetry.md`: terminal Batch accounting and residual durability contract.

## Verification

- Focused terminal/accounting tests: 78/78 passed on the final local tree.
- Serialized full suite: 123 files / 1,192 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed with 0 errors and 109 inherited warnings.
- Workflow YAML, preview/provision/ship shell parsing, and `git diff --check`: passed.
- Two final independent reviews: each passed after 74/74 focused tests, typecheck, lint, and diff check; neither found a remaining P0/P1/P2.
- Isolated preview version `359b12be-4a00-4923-97c0-b1f85400498a`: deployed; health reports `ok/db/schema=true`, `missing=[]`, and unauthenticated batch GET/POST admin routes return 401.
- Ready PR #394 is open; hosted CI/review, merge, production deploy, stale-job reconciliation, D1 receipt, and `usage.jays.services` receipt: pending.

## Follow-ups

- Reconcile production job `10611cb5-4e6e-4358-b638-4b530ae74c73` only after the corrected Worker is deployed.
- Confirm the terminal job's durable status, lifecycle timestamps, bounded result summary, extraction-row count, and measured usage without exposing provider document content.
- Verify the receiver records the additional OpenAI poll/result-file request attempts and any provider-reported token aggregate. Absence of an undocumented batch-level token aggregate must remain unknown, not fabricated.
- Repeating a settled status operation must return `alreadyFinished` without another provider request.
