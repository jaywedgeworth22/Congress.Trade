# Executive-branch (Presidential) trade tracking — OGE Form 278-T ingestion

Branch: `claude/antigravity-latency-security-x6lkvb` (Claude), owner-approved
("add Trump and track all his trades"; separate-by-default with an intuitive
branch filter).

## Summary

Trump files OGE Form 278-T periodic transaction reports (the executive
STOCK Act analogue of congressional PTRs — same 45-day clock, same amount
brackets; 17 filings Aug 2025 → Jun 2026, including two May 2026 reports
disclosing 3,711 trades worth $220M–$750M). This change ingests them:

1. **Source** (`app/src/ingestion/ogeSource.ts`): polls the OGE "President
   and Vice President Index" view (~6h cadence, fail-soft, Infisical-tunable
   `OGE_*` knobs), parses the `$FILE/*.pdf` links (single-quoted Domino hrefs,
   raw spaces, 2- and 4-digit year filenames — parser verified against the
   live index), and emits `DiscoveredFiling`s with `chamber='executive'`,
   filer `EXEC-DJT` / "Donald J. Trump". The normal pipeline takes over:
   fetch → classify (`scanned_pdf` — the filings are scans with garbage OCR) →
   vision extraction → review queue. Filings larger than
   `OGE_MAX_VISION_BYTES` (default 6MB; the May equity filing is 13MB/113
   pages) route straight to review without burning model budget — page-chunked
   extraction is the follow-up.
2. **Chamber contract**: the app-local `Chamber` union is widened to
   `house | senate | executive` (the shared package still says
   `house | senate`; upstreaming to `congress-trading-shared` v1.7 is the
   socialized follow-up). **Separate by default** at every layer:
   - Feed + analytics: absent `chamber` param = congressional view (executive
     excluded; NULL-chamber rows kept). `chamber` accepts a CSV multi-select
     (`house,senate,executive`).
   - Webhook/SSE subscriptions with NO explicit chambers filter never receive
     executive rows (existing subscribers can't be surprised by a 3,000-row
     filing); `chambers: ['executive']` opts in.
   - App-B surfaces: bulk snapshot exports market tables only (unaffected);
     congress-pit-scores explicitly excludes executive rows.
3. **UI**: both chamber dropdowns are now a House / Senate / Executive chip
   multi-select (default House+Senate, persisted per view, at least one chip
   always on; Executive chip tooltip explains OGE 278-T). `chamberLabel`
   renders "Executive"; Trump appears through the existing member
   drawer/profile machinery.
4. **Backfill**: `POST /api/admin/oge-backfill` force-polls the index and
   enqueues all unseen filings (idempotent).

## Files changed

- `app/src/ingestion/ogeSource.ts` (new) + `__tests__/ogeSource.test.ts`
- `app/src/ingestion/watcher.ts` — executive poll in `runWatcher`,
  `pollExecutive` export
- `app/src/extraction/orchestrator.ts` — oversized-executive guard
- `app/src/shared/types.ts` — Chamber widening + `OGE_*` Env knobs
- `app/src/delivery/rows.ts`, `rest.ts`, `subscriptions.ts` — chambers CSV +
  default exclusion + `__tests__/executiveDefaults.test.ts`
- `app/src/analytics/sql.ts`, `routes.ts` — asChambers + default exclusion
- `app/src/client/utils.ts` — asChambers; `app/src/export/pitScores.ts` —
  exclusion
- `app/src/admin/routes.ts` — `/oge-backfill` + config-sources registry
- `app/src/ui/dashboardHtml.ts` — chamber chips (+ test pins)
- `app/wrangler.toml`, `app/.dev.vars.example`,
  `app/docs/config-registry.md`, `app/docs/client-mobile-api.md`

No migrations (reuses filers/filings/transactions as-is).

## Verification

- `cd app && npm run typecheck && npm test` — all suites green (incl. new
  ogeSource + executiveDefaults files); embedded dashboard script parse pin.
- Parser run against the LIVE OGE index: 17/17 Trump 278-Ts extracted with
  correct dates.
- Post-deploy: `POST /api/admin/oge-backfill` → expect ~17 new filings;
  small filings flow to review/publish via vision extraction; 13MB equity
  filings appear in review as `oversized-executive`. Feed with
  `chamber=executive` shows published rows; default feed unchanged.

## Follow-ups

- Page-chunked vision extraction for 100+ page executive filings (the two
  May 2026 equity reports and April/June follow-ons).
- Upstream `'executive'` into `congress-trading-shared` (v1.7) and drop the
  app-local widening; then revisit App-B export inclusion.
- Optional: VP/cabinet filers (the index carries them; one `EXECUTIVE_FILERS`
  entry each). Filer photo/party enrichment for `EXEC-DJT`.
- EIGA §105(c) posture: reports are disseminated publicly in the site's
  educational framing (same statutory restriction language as the Senate eFD
  gate the site already handles); executive data stays un-paywalled.
