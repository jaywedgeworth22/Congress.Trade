# 2026-08-11 — LlamaParse tier decision: balanced, not agentic. Plus real backlog findings.

## Decision: standardize on `cost-effective` ("balanced") tier

Tested all three LlamaParse parse tiers against the scanned-PDF `review_queue`
backlog (~599 filings) via the existing dry-run `/api/admin/bakeoff` endpoint
(never publishes; results only in `extraction_runs`).

| Tier | Credits/page | Result |
|---|---|---|
| `fast` (`parse_page_without_llm`) | 1 | **Useless on real scans.** No OCR at all — pure text-layer parsing. 0/30+ successful attempts recovered any rows, exactly as expected for image-only PDFs with no embedded text layer. |
| `cost-effective` / **"balanced"** (`parse_page_with_llm` + `high_res_ocr`) | 3 | **The right tier.** 20 of 24 successfully-attempted docs (83%) recovered real, well-formed trades — 88 candidate rows total across the sample — from filings the local CPU OCR worker had blocked entirely. |
| `agentic` (`parse_page_with_agent`, Gemini 2.5 Flash) | 10 | **No improvement over balanced.** Directly compared on 4 docs where both tiers ran: identical row counts in every case (0=0, 0=0, 0=0, 6=6). ~3.3x the credit cost and noticeably slower (up to 73s vs balanced's 15-50s) for zero additional recall in this sample. |

**Decision: use `cost-effective`/balanced tier only. Do not spend agentic-tier
credits as part of the automated pipeline** — the docs balanced tier can't
recover are very likely genuinely unparseable by LlamaParse at any tier (see
findings below), not a "needs a smarter model" gap.

## The backlog is not what it looked like from row counts alone

Manually reading the raw PDFs for docs that came back empty on *every* tier
(fast, balanced, agentic) surfaced that the 599-filing "backlog" is not one
homogeneous pile of hard-to-OCR scans. At least three distinct categories are
mixed into `doc_kind='scanned_pdf'`:

1. **Genuinely recoverable scans** — real trades, real data, LlamaParse
   balanced tier just needed to be tried. E.g. `H-2025-20030641` (6 clean
   BTC/DIA/QQQ trades), `H-2025-8221173` (20 rows), `H-2025-8220834` (18
   rows). **This is the actual recovery opportunity.**
2. **Misclassified text PDFs** — `E-2023-william-j-burns-01-31-2023-278t`
   (CIA Director) is a genuine text-extractable PDF, not a scan at all. Read
   directly: two clean transactions (Exxon Mobil Corp. (XOM) Sale 01/24/2023
   $1,001-$15,000; General Electric Co. (GE) Sale 01/24/2023
   $1,001-$15,000). It was tagged `scanned_pdf` and routed to OCR-only paths
   it never needed. **These need a classifier fix, not an OCR escalation.**
3. **Genuinely empty filings** — `E-undated-marcia-fudge-2024-278term` is an
   OGE Form 278e **Termination Report**, not a PTR. Section 7 "Transactions"
   literally says **"None"**. There is nothing to recover — it's stuck in
   `review_queue` for a reason that has nothing to do with extraction
   quality. Both Burns and Fudge came from the `doc_class='empty'` bucket
   (94 filings, entirely Executive Branch filers) — worth auditing that
   whole bucket for the same pattern before spending any LlamaParse credits
   on it.
4. **Real, large, hard-scan filings that even LlamaParse can't crack** —
   `H-2025-8221264` (Rohit Khanna, the filing that started this
   investigation) is a genuine 24-page, hand-delivered photocopy scan
   covering three family trusts (Monte and Usha Ahuja 2010 Irrev Trust FBO
   Grandchildren; Ahuja Grandchildren's Education Trust; 2020 Trust FBO
   Khanna Children) with what turned out to be several hundred real,
   distinct transactions across dozens of tickers (META, NVDA, GOOGL, AAPL,
   AMZN, BRK.B, and more). The local OCR worker's uniform 0.189 confidence
   across 200+ rows reflected genuinely poor scan quality defeating
   Tesseract on a dense multi-trust table — not hallucinated duplication, as
   the row-limit-exceeded classifier's confidence-uniformity heuristic
   assumed. LlamaParse (both balanced and agentic) also returned 0 rows on
   it. This one was manually transcribed with adversarial page-by-page
   verification (separate note/PR) since it was worth the one-off effort
   given the volume of real data involved — not a template for the rest of
   the backlog.

**Implication:** before running LlamaParse balanced tier against the full 599
filings, doc_class buckets `empty` (94) and a chunk of the unclassified
bucket (386) should be spot-checked for the Burns/Fudge patterns first —
paying LlamaParse credits to OCR a document that has zero embedded
transactions, or that already has a text layer, is pure waste. The real
LlamaParse-worthy backlog is smaller than 599.

## Cost/throughput math for the real backlog

- 7 LlamaParse API keys, each with 1,000 free credits/month = **7,000 free
  credits/month** across the pool.
- Balanced tier = 3 credits/page. Backlog filings average ~1-2 pages
  (raw byte size avg ~80KB, min 5KB, max ~1MB — the 582KB Khanna filing at
  24 pages is a clear outlier, not representative).
- Even a conservative 2 pages/filing average across all 599 filings ≈ 1,198
  pages × 3 credits = **~3,594 credits** — about half the monthly free pool,
  comfortably inside budget with no paid overage, even before subtracting
  the Burns/Fudge-style filings that don't need LlamaParse at all.
- Empirically observed latency: 15-50s/request at balanced tier (up to ~50s
  seen on individual docs). The admin bakeoff endpoint used for testing this
  session serializes one doc at a time inside a single Cloudflare Worker
  HTTP request, and repeatedly hit Cloudflare's own edge/gateway timeout
  (524/502 errors) even at single-doc batches — that is a testing-harness
  constraint, not a LlamaParse rate limit, and does not reflect how the real
  pipeline should run this (see follow-up PR wiring LlamaParse into the
  actual extraction pipeline as an async escalation step rather than a
  synchronous admin-endpoint loop).

## Follow-ups tracked separately

- Wire LlamaParse balanced tier into the real extraction pipeline as an
  automatic escalation step for scanned_pdf filings that fail local CPU OCR
  (before falling back to paid OpenRouter/Grok vision, which should stay the
  last, most expensive resort) — see companion PR.
- Audit `doc_class='empty'` (94 filings) and the unclassified `scanned_pdf`
  bucket (386 filings) for Burns/Fudge-style non-issues before bulk-running
  LlamaParse against them.
- `/api/admin/bakeoff`'s single-doc Cloudflare edge timeouts under load are a
  real, separate reliability gap worth fixing if that endpoint keeps being
  used for manual testing/pilots.
