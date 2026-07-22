# Deno live-ingestion scheduler

## Summary

Deno Deploy served the API and ran daily jobs, but its `Deno.cron` handler did not invoke the existing `runWatcher` discovery loop. New House, Senate, and OGE filings therefore were not discovered by the production scheduler. The handler now runs the watcher every minute and flushes the durable ingestion and delivery outboxes on each tick.

## Files changed

- `app/src/deno/main.ts` — invoke `runWatcher`, `flushIngestionOutbox`, and `flushDeliveryOutbox` from the Deno cron handler; isolate failures so daily maintenance still runs.
- `.github/workflows/ci.yml`, `.github/workflows/deploy-deno.yml` — install pinned Deno 2.9.3 from npm on the Coolify runners before typecheck/deploy. The runner images provide neither Deno nor `unzip`, which the official setup action requires.
- `clients/pwa/package.json`, `clients/pwa/package-lock.json` — override Next's transitive `sharp` dependency to the patched 0.35.x line so the hosted high-severity audit gate is clean.
- `docs/EFFORT-LOG.md` — mirror the in-progress remediation state.

## Verification

- `npm exec --yes -- deno check src/deno/main.ts` — passed with Deno 2.9.3.
- `npx vitest run src/ingestion/__tests__/watcher.test.ts src/backfill/__tests__/houseCrawler.test.ts` — 2 files / 33 tests passed.
- `cd clients/pwa && npm audit --audit-level=high` — 0 vulnerabilities; PWA typecheck and 7 files / 31 tests passed.
- Full `npm test` — 155 files / 1,768 tests total; 1,767 passed and one pre-existing `src/shared/monitorBudgetGate.test.ts` timeout failed under the concurrent multi-agent host.
- No production deploy, admin backfill, remote migration, or production data mutation was performed by this lane.

## Follow-ups

- Fix the Deno Deploy token wiring and run hosted Coolify CI before landing.
- Deploy the scheduler fix, then verify source-health/log receipts and that new primary rows appear after the next polling interval.
- Run bounded official House historical backfill; implement or run an official Senate historical backfill; run OGE backfill if executive coverage is required.
- Run ticker/security, party/member, and price enrichment after ingestion; verify completeness by chamber, source, filing metadata, and current trade date.
