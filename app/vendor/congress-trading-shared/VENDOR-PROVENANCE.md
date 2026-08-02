# congress-trading-shared provenance

- Upstream: `https://github.com/jaywedgeworth22/congress-trading-shared`
- Immutable release: `v2.0.0`
- Commit: `19a077a4a8245963775c9fedb462a6741b0a70aa`
- Imported: `2026-07-22`
- Imported paths: `src/`, `package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md`, and `LICENSE`
- Local source modifications: reviewed patch in APPROVED-DRIFT.patch (extra $0-$1,000 STOCK_ACT_BRACKETS tier in src/brackets.ts; IsoDateTimeSchema + TradeEventRowSchema + AnalystRowSchema.asOfTimestamp in src/schemas.ts)

Congress.Trade's Deno import map resolves the package to `src/index.ts`; the
checked-in `dist/` and root compatibility files are older, unused build
artifacts and are intentionally outside this source provenance declaration.
