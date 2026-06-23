# Congressional Trade Feed — Design & Build-vs-Buy

_Author: Jay · Date: 2026-06-19 · Status: historical design context_

> Current implementation lives in `app/`. Use `README.md`, `AGENTS.md`,
> `app/README.md`, and `app/DEPLOY.md` for present-day onboarding and runbooks.
> This document is still useful for product rationale and original build-vs-buy
> decisions, but some implementation details have since shipped or changed.

A low-latency, low-cost service that watches US House and Senate STOCK Act
disclosures, ingests new filings (including scanned/handwritten PDFs) within
minutes, normalizes them, and pushes structured trade events to clients —
primarily as the data backbone for your own trading app.

---

## 1. Verdict: is it worth building?

**Yes, narrowly — build the *pipeline*, don't rebuild *history*.**

The data is free and public (STOCK Act 2012). Dozens of trackers already exist,
so you are not creating a new dataset; you are competing on **latency, control,
provenance, and cost-per-seat**. That edge is real and AI-cheap to capture:

- The inherent wall is the **45-day disclosure lag** — nobody beats it.
- Competitors add **hours-to-days** of *processing* latency on top. Your win is
  collapsing that to **minutes** after a filing hits the government server.
- Owning the pipeline removes per-seat API fees and ToS limits from third
  parties, and lets you keep **raw provenance + confidence scores** — which
  matters when the feed drives trades.

**The hard 20%** (budget your time here):
1. House PTRs filed on **paper → scanned image PDFs, sometimes handwritten** →
   require OCR / vision-model extraction. This is the actual engineering problem.
2. **Senate eFD scrape brittleness** — agreement gate, CSRF token, session
   cookie, DataTables POST endpoint.

**Effort estimate:** a working MVP feed (electronic filings + webhook + REST) in
~2 days. The scanned-PDF extraction + validation layer is another 1–2 days to
get trustworthy. Matches your "couple days + handful of tokens" framing.

---

## 2. Build vs. buy — recommended hybrid

Don't choose purely. **Seed + cross-check from cheap existing sources; run your
own watcher for the latency edge.**

| Source | Use it for | Cost |
|---|---|---|
| **QuiverQuant API** | Pragmatic API fallback + history seed; clean JSON, both chambers | ~$25/mo |
| **Capitol Trades** | Free UI/data cross-check & QA reference | Free |
| **house/senate-stock-watcher** (open JSON/CSV) | Free historical backfill, dedup baseline | Free |
| **Unusual Whales** | Only if you later want options-flow + contracts overlay | Paid |
| **Your own scraper** | **Primary low-latency feed** into your trading app | Hosting + tokens |

**Recommendation:** Build your own primary watcher. Subscribe to **QuiverQuant
($25/mo)** as a fallback/seed and to backfill history you should not re-OCR.
Use **Capitol Trades** + the open *-stock-watcher datasets as a free correctness
oracle (reconcile your parsed records against theirs nightly; alert on diffs).

Of the existing services specifically: **QuiverQuant** is the one to integrate
(API-first, both chambers, cheap). **Capitol Trades** is the best free reference.

---

## 3. Data sources — mechanics that matter

### House — `disclosures-clerk.house.gov`
- **Bulk index:** annual ZIP (e.g. `2025FD.zip`) containing an XML manifest of
  every filing: `DocID`, `FilingType` (`P` = PTR), member name, state/district,
  year. Refreshed ~nightly. This is your **change-detection feed**.
- **Individual PTR PDF:** predictable URL pattern
  `…/public_disc/ptr-pdfs/{year}/{DocID}.pdf`.
- **Two PDF flavors:**
  - **e-filed** (via `fd.house.gov`) → text-layer PDF, deterministic parse.
  - **paper** → **scanned image, sometimes handwritten** → needs OCR/vision.
- No push. You **poll** the index on a cron.

### Senate — `efdsearch.senate.gov`
- **Gate:** must POST acceptance of the agreement → sets session cookie; pull a
  **CSRF token** from the search page first.
- **Search:** POST to `/search/report/data/` returns **JSON** (DataTables
  format): filer, filing type, date, link.
- **Two filing flavors:**
  - **electronic PTR** → renders as an **HTML table** (no PDF, no OCR — easiest
    path of all; parse the DOM).
  - **paper** → scanned PDF → OCR/vision.
- Be polite: low request rate, cache the token/cookie, identify your agent.

**Implication:** Senate-electronic and House-e-filed are easy wins (structured/
text). Reserve the AI extraction budget for **scanned/handwritten** filings only.

---

## 4. PDF ingestion tooling

Route each document by type; only spend tokens where you must.

```
is_senate_electronic?  → parse HTML table (lxml/BeautifulSoup). No PDF.
has_text_layer(pdf)?   → pdfplumber / PyMuPDF (fast, free, deterministic).
else (scanned/handwr.) → vision-LLM extraction → JSON, with fallback OCR.
```

- **Text PDFs:** `pdfplumber` (table-aware) or `PyMuPDF` (fast). Free, no tokens.
- **Detect scanned:** if extractable text length ≈ 0, treat as image.
- **Scanned / handwritten (the AI win):** send page images to a **cheap vision
  model** (Gemini 2.x Flash or Claude Haiku) with a strict JSON schema +
  few-shot example of a PTR. One call transcribes *and* structures. Escalate to
  a stronger model only when confidence is low.
  - Traditional alternative: **AWS Textract** / **Google Document AI** then
    parse — more deterministic, weaker on handwriting, no LLM dependency.
  - Best practice: vision-LLM first, Textract as a second opinion on conflicts.
- **Validation gate (critical for a trading feed):**
  - Resolve `ticker` against a securities master (reject/flag unknowns).
  - `amount_min/max` must match the **STOCK Act bracket set** ($1,001–15,000;
    15,001–50,000; …). Off-bracket = parse error.
  - `transaction_date` ≤ `filed_date`; `tx_type ∈ {P,S,E}`.
  - Emit a **confidence score**; anything below threshold → `needs_review`
    queue, not the live feed.

---

## 5. App architecture

Pipeline of small, idempotent stages. Idempotency key = `DocID`.

```
        ┌── Cron (every 5–15 min) ────────────────────────────┐
        │  Watcher: House XML index + Senate search JSON       │
        │  diff vs seen DocIDs ──► enqueue new filings         │
        └───────────────┬─────────────────────────────────────┘
                        ▼
   Fetcher ─► raw PDF/HTML to object storage (audit copy)
                        ▼
   Classifier ─► {senate_html | text_pdf | scanned_pdf}
                        ▼
   Extractor ─► pdfplumber | HTML parse | vision-LLM/OCR ─► raw JSON
                        ▼
   Normalizer/Validator ─► ticker resolve, bracket check, confidence
                        ▼
   Persister ─► upsert by DocID (dedupe)  ──►  needs_review if low conf
                        ▼
   Notifier ─► fan out: Webhooks + SSE + (optional) push
```

### Data model (core tables)
- **filers**: `bioguide_id, chamber, full_name, party, state, district,
  committees[]`
- **filings**: `doc_id (PK), chamber, filer_id, filing_type, filed_date,
  source_url, raw_object_key, ingest_status, extractor, model_version,
  confidence`
- **transactions**: `id, doc_id (FK), filer_id, tx_date, owner
  (self/spouse/joint/dependent), asset_name, ticker, asset_type, tx_type
  (P/S/E), amount_min, amount_max, is_option, cap_gains_over_200, raw_text,
  confidence, created_at`
- **securities_master**: ticker ↔ name resolution (seed from any equities list).
- **subscriptions**: `id, client_id, delivery (webhook|sse), target_url,
  secret, filters (member/ticker/chamber/min_amount), cursor`

**Provenance is non-negotiable:** keep the raw file + parsed JSON + model
version + confidence for every transaction. You will need it to debug a bad
trade signal and to reconcile against Capitol Trades/Quiver.

---

## 6. Push delivery — options and the best two

| Mechanism | Direction | Best for | Cost/complexity |
|---|---|---|---|
| **Webhook (HTTP POST)** | server→server | **Your trading app**, other backends | Low; just need retry + HMAC |
| **SSE (Server-Sent Events)** | server→browser | **Live web dashboard**, one-way | Low; simpler/cheaper than WS |
| WebSocket | bidirectional | Interactive/streaming UIs | Higher; overkill for one-way |
| REST + cursor (poll) | client pulls | Catch-up, reconciliation, simplest clients | Lowest; always provide it |
| Mobile/email/SMS push | server→user | End-user alerts (later) | Add via Twilio/SendGrid |

**Pick two:**
1. **Webhooks** — primary, for your trading app and any server consumer. Sign
   payloads (HMAC), retry with backoff, make consumers idempotent on `DocID`.
2. **SSE** — for a live browser feed. One-way, runs over plain HTTP, far cheaper
   and simpler than WebSockets, auto-reconnects.

Always also expose a **`GET /transactions?since=<cursor>`** REST endpoint as the
reliable backstop (clients reconcile after downtime). Internally, fan out via a
queue (Cloudflare Queues / Redis pub-sub) so delivery failures don't block
ingestion.

---

## 7. Hosting — "super low ongoing expense"

**Recommended: Cloudflare stack** (matches near-zero idle cost; volume is low —
typically tens to low-hundreds of filings/day, often fewer).

- **Workers + Cron Triggers** — watcher + pipeline stages.
- **D1** (SQLite) — relational store for the tables above.
- **R2** — raw PDF/HTML audit copies (no egress fees).
- **Queues** — stage hand-off + webhook/SSE fan-out.
- **Workers AI or external API** — vision extraction for scanned PDFs.

**Cost:** fixed infra realistically **<$5–20/mo**; the only real variable is
**LLM tokens for scanned filings** — pennies per scanned doc with Flash/Haiku,
and most filings skip the LLM entirely. Heavy handwriting (Textract path) is the
only thing that can nudge cost up.

**Alternative:** a single small VPS (Hetzner/Fly.io ~$5/mo) running Python
(FastAPI + APScheduler + Postgres + S3-compatible storage) if you prefer a
conventional stack over Workers. Same design, slightly higher ops overhead.

---

## 8. Differentiators to bank the latency edge

- **Poll cadence 5–15 min** on both indexes (cheap; this is most of your edge).
- **Skip the LLM** for ~80% of filings (structured/text) → fast + free.
- **Confidence-gated feed**: never publish a low-confidence parse to the live
  webhook; route to review. Bad data is worse than slow data for trading.
- **Nightly reconciliation** vs Capitol Trades / *-stock-watcher; alert on diffs.
- **Committee/contract context** later (the paid players' real moat) — overlay
  committee assignments and USAspending contract awards per filer.

## 9. Legal / ToS notes
- Data is public under the STOCK Act; redistribution is generally fine.
- Respect each site's rate limits and the Senate agreement gate; identify your
  bot; cache aggressively. Don't hammer.
- Ship a clear **"not financial advice"** disclaimer with any client-facing UI.

---

## 10. Open decisions (need your input)
1. **Latency target:** 5-min poll (max edge) vs 15–30 min (cheaper, gentler)?
2. **Hosting:** Cloudflare Workers vs a small VPS — your preferred stack?
3. **Scanned-PDF extractor:** vision-LLM (Gemini Flash/Haiku) vs AWS Textract
   vs both-with-arbitration?
4. **Scope of v1:** feed-only (webhook + REST), or also a thin web dashboard
   (SSE) from day one?
5. **Seed source:** pay $25/mo for QuiverQuant to backfill history, or backfill
   from the free open datasets only?
