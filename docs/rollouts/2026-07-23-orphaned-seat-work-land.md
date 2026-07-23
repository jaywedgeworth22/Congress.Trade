# Orphaned Claude / Codex / Monet seat work — land residual + supersede

Date: 2026-07-23 · Seat: GROK

## Summary

Owner asked to PR and merge all remaining Claude/Codex/Monet unmerged work that
improves the app into production. Full cherry-inventory of remote seat branches
showed **nearly all unique commits already re-landed on `main` under later PRs**
(deno live ingestion, openrouter optimization, D1 budget, telemetry half-open,
house digit asset codes, admin market provider diagnostics, CI `CT_CI_RUNNER`,
bakeoff usage capture, latency `fmtMs`, KPI grid, etc.). Direct cherry-picks
all conflict with today's tree.

### Residual improvement still missing

- **CODEX `historical-record-backfill` / `0c7a98c`** — seed backfill stripped HTML
  option/description detail into a single `asset_name`. Ported:
  - `parseSeedAssetDescription` splits clean name vs description/supplemental
  - `assetTypeName` + option detection from seed type labels
  - seed UPSERT writes `asset_type_name`, `description`, `supplemental_text`

### Superseded (already on main; remote branches safe to delete)

Claude: `ci-hosted-fallback`, autofix/benchmark bakeoff series, `latency-fmt`,
`llamaparse-provider`, `openrouter-optimization`, `party-display-kpi-grid`,
`switch-agreement-model-b`, docs-only branches.

Codex: `admin-market-status`, `crossapp-contract-manifest`, `deno-live-ingestion`,
`enrichment-placeholders` (partially elsewhere), `house-asset-code-parsing`,
`integrate-infisical-bridge` (Infisical path evolved), `review-editor`,
`telemetry-half-open-lease`, docs closeouts.

Monet: `bakeoff-usage-cost`, `d1-read-cost-control`, `fmp-edgar-throttle`,
docs troubleshoot.

## Verification

```bash
cd app && npm test -- --run src/backfill/__tests__/seed.test.ts
# 19 passed
```

## Follow-ups

- Delete superseded remote seat branches after this PR merges.
- Optional: re-run seed backfill to backfill description columns on existing
  seed rows (idempotent UPSERT updates seed_dataset only).
