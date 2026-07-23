# Combine open PR queue into fewer lands

Date: 2026-07-23 · GROK

## What we did
Inventory of ~32 open "orphan land" PRs (Cursor/AG). Cherry-picked unique commits onto a single branch; only **3 residual improvements** applied cleanly with real code:

1. Benchmark slot validation — underlying OpenRouter providers (#810)
2. OpenRouter slug → openrouter transport attribution (#802)
3. fmtName generational suffix preserve (#792)

All other open PRs either already on main, docs-only, deps-pin churn, or conflicted with stale rewrites that would regress admin/ingestion.

## Verification
`cd app && npm test -- --run src/extraction/__tests__/` → 34 files / 468 tests passed.

## Follow-up
Close remaining open orphan PRs; delete remote heads after close.
