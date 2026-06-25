# Sharing FMP data with congress.trade

Paste the section below into the **other app's** chat/assistant. It tells that app
how to mirror the FMP data it already fetches into congress.trade so neither app
pays for the same FMP call twice.

---

## Instructions for the other app (copy from here)

You are working on **App B**, a Next.js app (running locally) that pulls market
data from **Financial Modeling Prep (FMP)**. There is a sibling app, **App A =
congress.trade**, a Cloudflare Worker (always-on, public) backed by a database.
Both apps use FMP. Goal: **share the data App B already fetches with App A**, so
App A rarely needs to call FMP itself (saving the shared daily FMP quota).

App A is the shared system-of-record. App B should **push** what it fetches to
App A's import endpoint right after each FMP call (or in a nightly batch).

### Endpoint

```
POST https://congress.trade/api/admin/securities/import
Headers:
  Authorization: Bearer <ADMIN_TOKEN or INGEST_TOKEN>
  Content-Type: application/json
```

> **Token:** use a **scoped `INGEST_TOKEN`** (set via `wrangler secret put
> INGEST_TOKEN` on App A) so the sending app never holds the full `ADMIN_TOKEN`.
> The ingest token authorizes *only* this endpoint; the full admin token still
> works too. App B stores whichever value as its `CONGRESS_TRADE_TOKEN`.

The endpoint is **idempotent** (safe to resend) and accepts any subset of three
arrays. Send whichever you have:

```jsonc
{
  // Company reference (from FMP /v3/profile/{symbol})
  "refs": [
    {
      "ticker": "AAPL",
      "companyName": "Apple Inc.",
      "sector": "Technology",
      "industry": "Consumer Electronics",
      "assetClass": "equity",          // equity | etf | adr | fund | other
      "isEtf": false, "isAdr": false,
      "country": "US", "stateHq": "CA", "stateOfIncorp": "DE",
      "exchange": "NASDAQ Global Select", "exchangeShort": "NASDAQ",
      "currency": "USD",
      "marketCap": 3200000000000,
      "sharesOutstanding": 15000000000,   // lets the importer keep cap current off the daily close
      "ipoDate": "1980-12-12",
      "cik": "0000320193", "sicCode": "3571", "sicDescription": "Electronic Computers"
    }
  ],
  // S&P 500 daily closes (from FMP /v3/historical-price-full/%5EGSPC). Send once/day.
  "spx": [ { "date": "2026-06-15", "close": 5400.2 } ],
  // Per-ticker daily closes (+ optional volume) from your OHLC source
  "prices": [
    {
      "ticker": "AAPL",
      "closes": [ { "date": "2026-06-15", "close": 210.1, "volume": 41230000 } ],
      "currentPrice": 210.1,
      "currentPriceDate": "2026-06-15"
    }
  ],
  // Insider (SEC Form 4) daily aggregates, keyed by ticker+date
  "insider": [
    { "ticker": "AAPL", "date": "2026-06-15", "sentiment": 62,
      "buyFilings": 3, "sellFilings": 1, "buyShares": 12000, "sellShares": 2000,
      "owners": ["Jane Director", "John Officer"] }
  ],
  // FINRA short-volume daily, keyed by ticker+date
  "shortVolume": [ { "ticker": "AAPL", "date": "2026-06-15", "ratio": 48.3, "elevated": false } ],
  // Fundamentals daily snapshot, keyed by ticker+date (week52High/Low also
  // accept the `52wHigh`/`52wLow` aliases)
  "fundamentals": [
    { "ticker": "AAPL", "date": "2026-06-15", "peRatio": 30.1, "eps": 6.2, "beta": 1.2,
      "dividendYield": 0.005, "week52High": 250, "week52Low": 160, "fcfYield": 0.03,
      "debtToEquity": 1.5, "epsGrowth": 0.08 }
  ],
  // Analyst consensus snapshot, keyed by ticker+date
  "analyst": [
    { "ticker": "AAPL", "date": "2026-06-15", "rating": "Buy", "targetMean": 240,
      "targetHigh": 300, "targetLow": 180, "targetMedian": 235, "analystCount": 40,
      "strongBuy": 20, "buy": 10, "hold": 8, "sell": 2, "strongSell": 0 }
  ]
}
```

App A upserts `securities_ref` / `spx_eod` / `price_eod` / `insider_eod` /
`short_volume_eod` / `fundamentals_eod` / `analyst_consensus` and recomputes
per-trade performance anchors for any imported ticker. Response:
`{ ok, refs, spxRows, pricedTickers, priceRows, perfTickers, insiderRows,
shortVolumeRows, fundamentalsRows, analystRows, errors }`. All upserts are
non-destructive (an incoming null never overwrites an existing value).

**Partial refs are fine.** If the sending app only has some columns (e.g.
`companyName` / `sector` / `industry` / `marketCap` but no `cik` / `exchange` /
`country` / `ipoDate` / `sicCode`), send what you have. The ref import is
non-destructive: it fills gaps via `COALESCE` (never overwrites an existing
non-null value with null) and does **not** mark the ticker enriched, so App A's
own FMP/SEC enrichment still completes the missing fields later. Prices/spx are
the expensive FMP calls and are fully shareable, so partial refs still capture
the bulk of the savings.

### Mapping FMP responses → this payload

- **`GET /v3/profile/{symbol}`** (array, take `[0]`) → one `refs` entry:
  `companyName, sector, industry, country, state→stateHq, exchange,
  exchangeShortName→exchangeShort, currency, mktCap→marketCap, ipoDate, cik`;
  set `assetClass` = `isEtf ? 'etf' : isAdr ? 'adr' : isFund ? 'fund' : 'equity'`.
- **`GET /v3/historical-price-full/{symbol}`** → one `prices` entry:
  `closes = historical.map(h => ({ date: h.date, close: h.adjClose ?? h.close }))`;
  `currentPrice = historical[0].adjClose ?? historical[0].close`,
  `currentPriceDate = historical[0].date` (FMP returns newest-first).
- **`GET /v3/historical-price-full/%5EGSPC`** → `spx` the same way (no ticker).

### When to send

- After each FMP fetch you make for your own purposes, forward it (cheap, idempotent).
- Or nightly: collect the tickers you touched that day + the S&P series and send
  one batched POST. Cap arrays reasonably (the endpoint accepts up to ~2,000
  tickers / 20,000 closes per call).

### Example (App B, Node/Next.js)

```js
async function shareWithCongressTrade({ refs = [], spx = [], prices = [] }) {
  const res = await fetch('https://congress.trade/api/admin/securities/import', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.CONGRESS_TRADE_TOKEN}`,
    },
    body: JSON.stringify({ refs, spx, prices }),
  });
  if (!res.ok) console.error('share failed', res.status, await res.text());
  return res.json();
}

// Example: after you fetch an FMP profile + price history for a symbol
function fmpProfileToRef(p) {
  return {
    ticker: p.symbol, companyName: p.companyName, sector: p.sector, industry: p.industry,
    assetClass: p.isEtf ? 'etf' : p.isAdr ? 'adr' : p.isFund ? 'fund' : 'equity',
    isEtf: !!p.isEtf, isAdr: !!p.isAdr, country: p.country, stateHq: p.state,
    exchange: p.exchange, exchangeShort: p.exchangeShortName, currency: p.currency,
    marketCap: p.mktCap, ipoDate: p.ipoDate, cik: p.cik,
  };
}
function fmpHistToPrices(symbol, hist) {
  const closes = (hist.historical || []).map((h) => ({ date: h.date, close: h.adjClose ?? h.close }));
  const top = closes[0];
  return { ticker: symbol, closes, currentPrice: top?.close, currentPriceDate: top?.date };
}
```

### Backfilling history fast (paid FMP tier)

If congress.trade has its own `FMP_API_KEY` (set via `wrangler secret put`), you
can fill all history quickly without App B. Raise the daily cap
(`wrangler secret put FMP_DAILY_CALL_CAP` → e.g. `100000`) and loop the bounded
backfill until it reports `done: true`:

```bash
cd app
BASE=https://congress.trade TOKEN=your_admin_token ./scripts/backfill-market.sh 40 250
#                                                                            ^max ^calls/min
```

Each pass runs one safe batch of enrichment + price refresh (bounded by the
Worker's per-request limits) and `maxPerMinute` throttles FMP to stay under your
plan's rate. `GET /api/admin/enrich-securities/status` reports
`pendingTickers` / `pricePendingTickers` as it drains.

### Reverse direction — read App A's cache (cache-aside)

App A also pulls FMP (its own key + daily cron + backfill), so App B can reuse
that instead of spending its own quota. These public, read-only endpoints mirror
the import payload shapes, so App B can check App A first and only call FMP on a
miss (then push the result back via the import endpoint, closing the loop):

```
GET /api/market/ref/{TICKER}                      -> { ref }
GET /api/market/refs?tickers=AAPL,MSFT,...        -> { refs: [...] }   (≤500)
GET /api/market/prices/{TICKER}?from=&to=         -> { ticker, closes:[{date,close}], currentPrice, currentPriceDate }
GET /api/market/spx?from=&to=                     -> { closes:[{date,close}] }
GET /api/market/bundle/{TICKER}?from=&to=         -> { ref, prices, spx }   (one round-trip)
GET /api/market/insider/{TICKER}?from=&to=        -> { ticker, rows:[{date,sentiment,buyFilings,sellFilings,buyShares,sellShares,owners}] }
GET /api/market/short-volume/{TICKER}?from=&to=   -> { ticker, rows:[{date,ratio,elevated}] }
```

`price` closes now include `volume` (null until populated).

`from` / `to` are optional inclusive `YYYY-MM-DD` bounds. No auth required (reads
are safe). Suggested App B flow per symbol:

```js
const r = await fetch(`https://congress.trade/api/market/bundle/${sym}`);
const { ref, prices } = await r.json();
if (ref && prices.closes.length) {
  // cache hit — use App A's data, skip FMP entirely
} else {
  // miss — call FMP, then POST it back to /api/admin/securities/import
}
```

### Security

- The import endpoint is **write-authenticated** (bearer token). Do not expose an
  unauthenticated write path; store the token in App B's server env
  (`CONGRESS_TRADE_TOKEN`), never in the browser.
- Reads are public and safe to call from anywhere.

---

## Congressional trades feed (App A is the system of record)

Stop scraping congressional disclosures elsewhere — read them from App A:

```
GET https://congress.trade/api/transactions?since={cursor}&ticker=&member=&chamber=&type=&limit=
    -> { transactions:[...], cursor, count, total, limit, premium, gated, freeWindowDays }
GET https://congress.trade/api/analytics/...   (leaderboards, cluster buys, sector mix, per-ticker, …)
```

Poll forward with the returned `cursor` (pass it as the next `since`).

**The feed is fully public** — no token, no row gating. Page forward by cursor to
cover any window (e.g. a rolling 90 days); pass `limit` for page size. The
freemium boundary is currently the premium-only full-history CSV export, not the
feed rows or public analytics.

Per-transaction object (each item in `transactions[]`):

```
{ id, docId, filerId, txDate, owner, assetName, ticker, assetType, txType,
  amountMin, amountMax, isOption, capGainsOver200, rawText, confidence,
  source, createdAt, cursorSeq,
  fullName, state, photoUrl, filedDate, firstSeenAt,
  chamber, memberName, refSector, refMarketCap, refCountry, refExchangeShort }
```

Mapping to a typical `CongressTrade`:

| CongressTrade | from |
|---|---|
| `symbol` | `ticker` |
| `member` | `memberName` (or `fullName`) |
| `chamber` | `chamber` (`"house"｜"senate"`) |
| `side` | `txType`: `P`→buy, `S`/`S_partial`→sell (ignore others) |
| `amountLow` / `amountHigh` | `amountMin` / `amountMax` |
| `owner` | `owner` (Self/Joint/Spouse/Child) |
| `tradedAt` | `txDate` (date-only `YYYY-MM-DD`) |
| `disclosedAt` | `filedDate` (date-only `YYYY-MM-DD`) |
| `source` | `source` (`primary`｜`seed_dataset`) |

## Ops / health

- `GET /api/health` → `{ ok, db, time }` — liveness + D1 connectivity (`db:false`
  means the database is unreachable or unmigrated).
- **Apply migrations to production** (the common cause of 500s on DB-backed
  routes): use `npm run migrate:remote`, `npm run deploy:full`, or
  `ADMIN_TOKEN=... bash scripts/ship.sh` depending on the production path chosen
  in `DEPLOY.md`. The plain `npm run migrate` is **local-only**.

## Read-back routes (avoid re-paying for donated data)

These public reads let a sibling app pull back data it (or our enrichment)
already stored, instead of re-calling a paid provider. All are read-only,
no-auth, and mirror the `?from=&to=` shape of `/api/market/insider`:

- `GET /api/market/fundamentals/:ticker?from=&to=` → rows of
  `{ date, peRatio, eps, beta, dividendYield, week52High, week52Low, fcfYield,
  debtToEquity, epsGrowth, source, updatedAt }` from `fundamentals_eod`.
- `GET /api/market/analyst/:ticker?from=&to=` → rows of
  `{ date, rating, targetMean/High/Low/Median, analystCount,
  strongBuy/buy/hold/sell/strongSell, source, updatedAt }` from `analyst_consensus`.

Consumer side (agentic-trading) should add a top-of-cascade tier in
`src/lib/data-providers.ts` that reads these before hitting a paid enrichment
provider — see the cross-app data-sharing plan.

## Bulk snapshot export (full-history bootstrap / catch-up)

The per-ticker reads above are for incremental, one-symbol cache-aside. To
**bootstrap from scratch** or **catch up after a downtime gap**, App B can pull
a daily, date-partitioned NDJSON snapshot of the whole market-data set instead of
walking thousands of per-ticker calls. App A writes the snapshot to R2 once a day
(in the daily cron, after enrichment + price refresh) and serves it token-gated.

```
GET https://congress.trade/api/export/bulk-snapshot
Headers: Authorization: Bearer <INGEST_TOKEN>          # same scoped token as /securities/import
Query:   ?date=YYYY-MM-DD   (optional, default today UTC)
         ?tables=price_eod,spx_eod,securities_ref,fundamentals_eod,analyst_consensus  (optional, default all)
         ?format=ndjson     (only ndjson; csv/parquet are not offered)
```

Returns a **manifest** (no row data) — object keys, row counts, the column
schema, and a per-table `downloadPath`:

```jsonc
{
  "generatedAt": "2026-06-25T04:01:00.000Z",
  "snapshotDate": "2026-06-25",
  "format": "ndjson",
  "tables": {
    "price_eod":  { "objectKey": "bulk/2026-06-25/price_eod.ndjson",  "rowCount": 412000,
                    "downloadPath": "/api/export/bulk-snapshot/file?date=2026-06-25&table=price_eod" },
    "spx_eod":    { "objectKey": "bulk/2026-06-25/spx_eod.ndjson",    "rowCount": 9500,  "downloadPath": "…" },
    "securities_ref":   { /* … */ }, "fundamentals_eod": { /* … */ }, "analyst_consensus": { /* … */ }
  },
  "schema": { "price_eod": ["ticker","date","close","volume"], /* … all five … */ }
}
```

Then download each table's NDJSON (one JSON object per line) and stream-parse it:

```
GET /api/export/bulk-snapshot/file?date=2026-06-25&table=price_eod
Headers: Authorization: Bearer <INGEST_TOKEN>
→ application/x-ndjson  (stream line-by-line; each line is one row object)
```

Notes for App B:
- **No presigned URLs.** The R2 binding in the Workers runtime can't sign URLs, so
  downloads go through the token-gated `downloadPath` (same `INGEST_TOKEN`).
- **Idempotent + watermarked.** Re-running a date overwrites the same keys.
  Compare the manifest's `snapshotDate` + per-table `rowCount` against your own
  watermarks and only download tables that moved; store `snapshotDate` so repeated
  pulls skip already-ingested data.
- **A missing past date is `404`**; today's snapshot is generated inline on first
  request if the cron hasn't written it yet.
- **What's NOT here:** the congressional-trade corpus (use the paged
  `/api/transactions` feed), `tx_performance` (derive it from `price_eod`+`spx_eod`),
  and `insider_eod`/`short_volume_eod` (those flow App B → App A, so they're not
  echoed back).
