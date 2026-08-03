# Ingestion → publication pipeline improvement ledger

Owner directive (2026-08-02): track every way to make the trade
ingestion/publication pipeline more **efficient, affordable, prompt, thorough,
and autonomous**, from lessons learned in the 2026-08-01/02 recovery work.

Status: living document. Each item: lesson → proposal → status.

## Flagship: Mac-local scanned-PDF processing lane ("local vision worker")

**Lesson.** ~40% of the extraction backlog was scanned paper PTRs that need
vision. OpenRouter vision costs money per doc and died on the weekly budget
(2026-07-25). Meanwhile a Mac did the same job for $0 marginal: macOS Vision
OCR reads the forms cleanly, and LLM subagents transcribe checkbox grids
(P/S/E marks, A–J amount brackets) accurately.

**Proposal.** A launchd-managed local worker (sibling to `scout/`):
1. App exposes "unprocessed scanned filings" (or the worker watches the
   existing detections feed): any filing whose `doc_kind='scanned_pdf'` and not
   yet extracted.
2. Worker downloads the PDF (residential egress — same IP the scout already
   uses successfully), OCRs (macOS Vision, free), parses deterministically
   where possible, and transcribes checkmarks (template grid detection — see
   item 6 below; LLM-vision only as escalation).
3. POSTs structured rows back to the app (new ingest endpoint or existing
   App-B import), provenance `source='local_mac'` (distinct from `'manual'`),
   same `(doc_id, source, row_key)` idempotency contract.
4. **App-side wait/fallback:** when a scanned filing classifies, the app marks
   it `extraction_pending_local` and waits a BRIEF bounded window (e.g.
   10–15 min) for the Mac lane before falling back to the normal vision
   path. If the Mac is offline/backlogged, nothing changes vs today — the
   fallback fires on schedule. A worker heartbeat lets the app shorten the
   window when the Mac is provably alive.
5. Cost: electricity. Latency: minutes (vs OpenRouter seconds) — acceptable:
   scanned filings are ~40/month steady-state and not latency-race-critical.

**Robustness constraints (owner):** app must work fully without the Mac
(fallback path unchanged); Mac lane strictly additive; never blocks
ingestion; dedupe with the LLM path via existing exactLiveSet semantics
(manual/local rows count as the live set; LLM re-extraction no-ops).

**Status:** proposed. Validation data from the 2026-08-02 manual swarm run
(247 docs) attaches as it lands.

## Lessons → proposals (running list)

1. **Phantom frontier detections** (scout HEAD blanket-OK → 900 ghost
   filings, 2026-07-30). Fixed: scout requires `content-type: application/pdf`.
   Proposal: prod ingest endpoint also validates (server-side HEAD before
   creating filing rows from external detections). Status: scout fixed;
   server-side proposed.
2. **404 ≠ missing.** House bulk FD index precedes PDFs by days; the Clerk
   WAF also masks rate-limiting as 404. Fixed in #1223 (7-day
   not-yet-published window + 403 transient). Keep fetch error taxonomy
   source-aware; never terminal-error fresh 404s.
3. **Doc-kind pre-classification at discovery.** Phantoms + not-yet-posted
   docs clogged extraction. Proposal: cheap HEAD/classify at discovery so
   downstream lanes only see fetchable docs.
4. **Write-lock discipline.** SQLITE_BUSY_SNAPSHOT wedge (2026-08-02):
   never hold a DB txn across network I/O; long multi-write admin routes
   lose snapshot races to queue writes. Proposal: app-wide txn-across-I/O
   audit; short write txns; BEGIN IMMEDIATE for batch writers; busy_timeout
   on every connection; keep WAL small (litestream checkpoint cadence).
5. **Deterministic-first extraction.** 21 text_pdf PTRs extracted with a
   120-line regex parser at $0, perfect accuracy — LLM only needed for
   scans. Proposal: run the deterministic parser in-app for digital House
   PTRs before any LLM call (~60% of PTR volume); LLM fallback on
   parse-zero/low-confidence.
6. **Checkbox grid detection for paper forms.** Paper PTR type/amount are
   X-marks in a fixed template grid — deterministic image analysis (grid
   projection + per-cell ink density) can read them; swarm agents
   independently built and cross-validated pixel-darkness checkers during
   the 2026-08-02 run (corrected several eyeball errors). If ≥99% on
   brackets vs LLM-read ground truth, the Mac lane needs no LLM at all for
   standard forms.
7. **Queue priorities.** Telemetry flood (2,999 msgs) starved filings 3
   days (fixed by drain limits + priority tiers). Keep telemetry strictly
   last; alert when filing.new age > 1h.
8. **R2 raw-bytes durability.** 34 filings pointed at R2 objects that never
   landed (July credential window). Proposal: verify object existence after
   write (HEAD); periodic reconcile scan → auto refetch.
9. **Filer-id at discovery.** 900/923 error docs had NULL filer_id.
   Proposal: compute filer_id at discovery from the index row (name +
   StateDst) so every downstream lane has it.
10. **OpenRouter budget observability.** Extraction died silently on a
    weekly cap. Proposal: first-class Pushover alert on budget-403s +
    automatic failover to a second key/provider before terminal error.
11. **Amendment handling.** Several scanned docs are amendments. Verify the
    app supersedes/amends prior rows correctly (test with a real amendment
    pair); extraction lanes must tag amended=true.
12. **Duplicate-tolerant row keys.** Trust-account splits produce identical
    (asset,date,type,amount) rows that are legitimately distinct (verified
    on Harshbarger CHEGG 2021-02-18, six family trusts). Any dedupe key
    MUST include owner/account context or it undercounts real trades.
13. **LLM-vision quality gates.** For any vision lane: mechanical
    validation (bracket↔amount consistency, date ≤ filed_date) + sampled
    re-read of ~10% before publish. Proven workflow from the 2026-08-02
    swarm.
