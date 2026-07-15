# Brand exploration — logo, wordmark font, and domain portfolio

Date: 2026-07-12/13 · Owner: Jay · Explored by CLAUDE (cloud session)
Interactive design sheets (self-contained HTML, open in any browser):
- `docs/brand/assets/logo-concepts.html` — five logo directions, dark/light
  renders, header lockups, favicon tests, R/W/B studies, five font options.
- `docs/brand/assets/branch-toggle-concepts.html` — the H/S/P branch-filter
  exploration that produced the shipped segmented strip (kept for the record).

## Decisions made (owner-approved)

1. **Wordmark font: F3 "Typewriter Slab"** — production face **Zilla Slab**
   (600/700, OFL license, self-hosted subset; fallback stack
   `'American Typewriter', Rockwell, 'Courier New', serif`). Chosen for
   filed-paperwork energy — the PTR forms themselves. Applied to `.brand` in
   `dashboardHtml.ts` (PR #357); the self-hosted Zilla Slab subset embed is
   tracked follow-up work.
2. **Branch filter: segmented H·S·P strip** (concept 04 of the toggle sheet)
   with per-letter hover text and one grouped ⓘ explainer per strip — SHIPPED
   in PR #357. P = President, analogous to H/S.

## Logo directions (not yet decided — pick one)

| # | Name | One-liner | Best use |
|---|------|-----------|----------|
| 1 | **Candlestick Colonnade** ⭐ recommended | Capitol dome + entablature carried by columns that are literally red/green candlesticks — government architecture built from market data. Red/green persists at ALL sizes (owner direction); structure color adapts to context. | Primary mark, favicon, app icon |
| 2 | Capitol Skyline sparkline | One continuous price line traces the full Capitol elevation (wing wall → wing roof → center block → dome with lantern tick → down the far side) and exits still trading. | Animated hero / OG image / loading state |
| 3 | C·T ticker monogram | C and T set like a ticker symbol; the domain's period drawn as a green candle (nudged low-right per owner). Letterforms need outlining for final art. | Tiny contexts; transfers to sibling brands (F·4, L·T…) |
| 4 | Disclosure Stopwatch | Stopwatch whose face holds the full mini-Capitol (dome, entablature, colonnade, base) with a rising hand — the 45-day clock + "we're first" claim. Includes two red/white/blue studies (white case/blue Capitol/red hand on dark; navy+red on white) — R/W/B works here because it can't be misread as buy/sell. | Latency scoreboard sub-brand, alert receipts, pricing proof strip |
| 5 | Wordmark with candle period | No symbol; the name in the chosen slab with the period drawn as a green candle sitting near the baseline. The lone candle-dot doubles as a favicon. | Cheapest full identity; one glyph swap from what ships |

**Recommended pairing:** 01 as primary (mono-accent chrome / semantic-color
marketing) + 05's candle-period folded into the wordmark + 04 reserved as the
latency sub-brand. 02 becomes the animated hero, not a logo.

**Font options catalogued** (sheet section 06): F1 System Grotesk
(Inter/Söhne), F2 Civic Serif (Source Serif 4/Tiempos), **F3 Typewriter Slab
(Zilla Slab) — CHOSEN**, F4 Data Mono (IBM Plex Mono), F5 Masthead Condensed
(Archivo Condensed).

## Domain portfolio — trading-data verticals ("filings streamed to traders")

DNS-probed 2026-07-12 from the cloud session ("clear" = no DNS record →
likely registrable; **verify at a registrar before relying on this**).
Resolver sanity-checked against congress.trade (resolves).

| Domain | Vertical | Probe |
|---|---|---|
| `insider.trade` / `form4.trade` | SEC Form 4 corporate-insider trades — most natural next vertical, same file→parse→relay loop | both clear |
| `whales.trade` | 13F institutional holdings deltas | clear |
| `judges.trade` | Federal judiciary financial disclosures (same statutory family as STOCK Act) | clear |
| `lobby.trade` | LDA lobbying registrations/quarterlies mapped to tickers | clear |
| `contracts.trade` | Government contract awards (USASpending/FPDS) → public vendors | clear |
| `parliament.trade` | UK/EU/CA legislator disclosures | clear |
| `docket.trade` | Litigation/regulatory docket events as market signals | clear |
| `filings.trade` / `disclosure.trade` | Umbrella for the whole ingestion engine | both clear |
| `firstprint.trade` | Brand for the relay engine — "we get the print first" (the latency scoreboard already proves it) | clear (`firstprint.io` taken) |
| `tapefirst.com` | Same energy, .com | clear |
| disclosurewire.com, filingfeed.com, openfilings.com, civicalpha.com | — | all taken |

**Strategy note:** the `.trade` house-of-brands pattern wins — one backend,
one `[source].trade` naming grammar, instant legibility, and the C·T
candle-period logo system transfers to every sibling.

## Open items

- Pick the primary logo mark (recommendation above) → final vector pass
  (outline monogram letterforms), swap site favicon + header mark.
- Self-host the Zilla Slab subset for the wordmark (font fetch is
  permission-gated in cloud sessions; needs the woff2 committed).
- Register any domains worth defending before the latency-scoreboard
  marketing draws attention to the niche.
