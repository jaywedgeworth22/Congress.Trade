# Shared v1.5.0 Consumer Closeout

## Summary

Congress.Trade now exact-pins `congress-trading-shared` v1.5.0, resolving released commit
`2222baeb`. This closeout records the already-merged and already-deployed state, refreshes the
required isolated preview from the clean merged tree, and fixes a newly observed Uptime Monitor
GitHub-output framing failure.

## Why

PR #296's code was correct, but its branch records said `^1.5.0`, marked the work completed before
merge, and omitted STATUS/rollout receipts. GitHub records that PR merged as `d84fd349` at
2026-07-11T18:58:28Z. Wrangler records production versions `c5deb474` and `e5c7ebad` immediately
afterward, even though the isolated preview had not been refreshed from this dependency tree.

Separately, scheduled Uptime Monitor run `29164917660` failed with
`Invalid value. Matching delimiter not found`. `curl` wrote compact JSON without a trailing newline,
so the random GitHub-output terminator was concatenated to the response body. The workflow now uses
`printf` to guarantee that the terminator starts on its own line. The random delimiter remains in
place to prevent response content from colliding with a static marker.

## Files changed

- `.github/workflows/uptime-monitor.yml`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-11-shared-v150-closeout.md`
- `/Users/jay/apps/CONGRESS-TRADE-EFFORT-LOG.md` (branch-neutral live board)

## Verification

- PR #296 app/PWA/security/pin checks: green; app suite reported 940 tests.
- Production: `GET https://congress.trade/api/health` -> HTTP 200,
  `{"ok":true,"db":true,"schema":true,"missing":[]}`.
- Preview before this closeout: HTTP 200 but last Wrangler deployment was 2026-07-11T16:42:02Z,
  before PR #296.
- Workflow framing regression harness: compact JSON without a final newline produced exactly three
  output lines, with the response on line 2 and the random delimiter alone on line 3; pass.
- `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/uptime-monitor.yml")'`: pass.
- `cd app && npm ci`: 228 packages; audit 0.
- `cd app && npm run lint`: 0 errors / 100 inherited warnings.
- `cd app && npm run typecheck`: pass.
- `cd app && npm test`: 106 files / 940 tests passed.
- `cd clients/pwa && npm ci`: 70 packages; audit 0.
- `cd clients/pwa && npm run typecheck && npm test && npm run build`: pass; 3 files / 13 tests and
  Next.js production build.
- `cd app && npm run preview:deploy`: pass after idempotently rediscovering existing isolated
  resources; preview D1 migrations were current and fixture seeding wrote only the isolated preview
  database. Worker version `4d8a558b-1ebb-450d-a4b2-b48688995eb1` deployed at 20:09Z.
- `GET https://congress-trade-preview.jaywedgeworth22.workers.dev/api/health`: HTTP 200,
  `ok/db/schema=true`, `missing=[]`.
- Production immutability check: latest production deployment remained
  `e5c7ebad-b38b-4360-b5b7-1e652cf2b89e` from 18:59Z; apex health remained HTTP 200.

## Follow-ups

- Ready PR #297 contains the closeout and workflow fix; it is not merged and has no auto-merge.
- Production is deliberately not redeployed by this closeout.
- No production D1, KV, R2, queue, config, secret, migration, ingestion, or backfill operation is in
  scope.
- The repository has no `PLAN.md`; this rollout and `STATUS.md` are the durable closeout records.
