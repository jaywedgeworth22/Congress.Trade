# Open-Source Lessons for Congress.Trade

**Date:** 2026-07-29
**Author:** KIMI (agent)
**Status:** Research note — backlog candidates, no code changes
**Method:** GitHub repository search (official MCP) + web search, 2026-07-29. Star counts are point-in-time.

## Context

Owner question: which open-source repos hold lessons for Congress.Trade? This note
records the survey results and distills actionable takeaways for our ingestion,
extraction, normalization, delivery, and product surfaces.

---

## 1. Direct domain: disclosure ingestion & parsing

### `timothycarambat/senate-stock-watcher-data` (~96 stars)
<https://github.com/timothycarambat/senate-stock-watcher-data>

The canonical open dataset of Senate eFD filings (powers senatestockwatcher.com);
this repo is the lineage of the GitHub raw mirror / S3 bucket we already seed from.

- **Data-as-repo publishing.** They commit normalized JSON per filing, giving
  consumers free versioning, diffs, and CDN distribution via GitHub raw. If we ever
  publish our normalized transactions as a public good (credibility + SEO), this is
  the distribution pattern to copy.
- **Its failure modes are our lesson.** We already hit them (House S3 default
  returns 403, Senate GitHub raw mirror intermittently 429s — see AGENTS.md).
  Third-party mirrors are inherently flaky; first-party ingestion from
  efdsearch.senate.gov / disclosures-clerk.house.gov (plus our relay fallbacks)
  remains the durable path. Seed sources stay a backstop, never the primary.

### `unitedstates/congress` (~1,058 stars) and `unitedstates/congress-legislators` (~2,414 stars)
<https://github.com/unitedstates/congress> · <https://github.com/unitedstates/congress-legislators>

The gold standard for U.S. civic data pipelines, maintained for over a decade.

- **congress-legislators is the canonical member identity table**, keyed on bioguide
  IDs, with party/state/district history. Even the commercial Apify scrapers enrich
  from it. If our member normalization is not anchored on bioguide IDs, adopting
  them as the join key is a cheap, high-value correctness fix (name strings drift;
  bioguide IDs do not).
- **unitedstates/congress shows long-lived hostile-source scraping done right:**
  idempotent fetch → parse → immutable artifact → diff, with per-source isolation
  and retries. Compare against our ingestion sources; the immutable-artifact step is
  what makes reprocessing and audit trails cheap.

### `openstates/openstates-scrapers` (~909 stars)
<https://github.com/openstates/openstates-scrapers>

Scraper-fleet engineering at scale (50+ state legislatures behind one schema).

- **Per-jurisdiction adapter behind a single normalized schema** — exactly our
  House/Senate/Executive three-adapter problem. Their discipline: adapters may
  differ wildly, output never does.
- **Scrape → dedupe → import separation** validates our ingestion → extraction →
  normalization layering; worth re-reading when we touch queue semantics.

---

## 2. Product/schema: what commercial scrapers converged on

Not open source code, but the public schemas of the Apify actors
(**johnvc/us-congress-financial-disclosures-and-stock-trading-data**,
**inexhaustible_glass/congress-stock-trades**) reveal what the market pays for:

- **One row per PTR transaction**; amount ranges kept *exactly as filed*, with
  computed min/max/estimate added alongside (never replacing the filed range).
- **STOCK Act compliance flags** (`on-time / late / severely late`) derived from the
  45-day rule — a differentiated, compute-once normalization field that journalists
  and watchdogs specifically filter on.
- **Owner attribution** (self / spouse / joint / dependent) as a first-class
  dimension, not buried in a notes field.
- **Filing/document IDs on every row** for source traceability (audit-ready pulls).
- `johnisanerd/Apify-Congressional-Trading-Data-Scraper`
  (<https://github.com/johnisanerd/Apify-Congressional-Trading-Data-Scraper>)
  exposes the dataset as an **MCP tool** — a distribution channel worth noting for
  our `/api/client/v1/*` contract's future.

---

## 3. Full-stack civic products

### `govtrack/govtrack.us-web` (~412 stars)
<https://github.com/govtrack/govtrack.us-web>

The best example of turning this class of data into a durable product: per-entity
public pages (SEO), subscription alerts on legislator activity (our Delivery /
Premium model), and a decade of keeping a cron + email pipeline alive.
`govtrack/misconduct` is additionally a model for curated-data-over-scraped-data
layers — editorial records that sit on top of the automated feed.

### Small trackers (all <25 stars)
`abdkhan-git/StockInsightsTracker`, `TommasoAmici/capitoltrades`, and a dozen
pelosi-bot clones. The graveyard of single-feature trackers. Lesson: alerting on
one member is a feature, not a product — our moat is normalization quality and
delivery reliability, not the raw feed.

---

## 4. Cautionary notes

- **ProPublica's Congress API was sunset.** Depending on someone else's free civic
  API is an existential risk — validates our first-party ingestion investment.
- **The space tops out around ~100 stars.** Nobody has built the definitive open
  implementation. The opportunity is real, but so is the reason: PDF extraction and
  member-identity matching are where everyone dies — precisely where our
  extraction/normalization investment sits.

---

## 5. Backlog candidates (prioritized)

1. **Anchor member identity on bioguide IDs** from `congress-legislators`
   (normalization). Name strings drift across sources; bioguide IDs are stable and
   give us free party/state/district enrichment. *Effort: S–M. Value: high.*
2. **Add STOCK Act late-disclosure flag** in normalization (`on_time / late /
   severely_late` from transaction date → filing date vs the 45-day rule).
   Compute-once, differentiating, and directly filterable in UI/API.
   *Effort: S. Value: high.*
3. **Audit ingestion against the unitedstates/congress pattern** — verify every
   source produces an immutable raw artifact (R2) before parse, and that reprocessing
   a filing is idempotent end-to-end. *Effort: M. Value: medium-high (reliability).*
4. **Evaluate owner-attribution normalization** (self/spouse/joint/dependent) as a
   first-class field if extraction already captures it. *Effort: M. Value: medium.*
5. **(Optional, product) Publish normalized transactions as a public data repo** in
   the senate-stock-watcher-data style — credibility and SEO asset, near-zero infra
   cost. *Effort: M. Value: medium.*
6. **(Optional, distribution) MCP tool exposure** of the client API, modeled on the
   Apify actor pattern. *Effort: M. Value: exploratory.*

---

## Sources surveyed (2026-07-29)

| Repo | Stars | Relevance |
|---|---|---|
| unitedstates/congress-legislators | ~2,414 | Member identity table (bioguide) |
| unitedstates/congress | ~1,058 | Long-lived gov scraper pipeline pattern |
| openstates/openstates-scrapers | ~909 | Multi-source adapter fleet, dedupe discipline |
| govtrack/govtrack.us-web | ~412 | Full product: alerts, SEO pages, longevity |
| timothycarambat/senate-stock-watcher-data | ~96 | Our seed-source lineage; data-as-repo pattern |
| abdkhan-git/StockInsightsTracker | ~22 | Single-member alert clone (anti-pattern) |
| johnisanerd/Apify-Congressional-Trading-Data-Scraper | n/a | MCP distribution pattern |
| Apify actors (johnvc, inexhaustible_glass) | n/a | Market-validated PTR schema conventions |
