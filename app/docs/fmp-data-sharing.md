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
      "ipoDate": "1980-12-12",
      "cik": "0000320193", "sicCode": "3571", "sicDescription": "Electronic Computers"
    }
  ],
  // S&P 500 daily closes (from FMP /v3/historical-price-full/%5EGSPC). Send once/day.
  "spx": [ { "date": "2026-06-15", "close": 5400.2 } ],
  // Per-ticker daily closes (from FMP /v3/historical-price-full/{symbol})
  "prices": [
    {
      "ticker": "AAPL",
      "closes": [ { "date": "2026-06-15", "close": 210.1 } ],
      "currentPrice": 210.1,
      "currentPriceDate": "2026-06-15"
    }
  ]
}
```

App A upserts `securities_ref` / `spx_eod` / `price_eod` and recomputes per-trade
performance anchors for any imported ticker. Response: `{ ok, refs, spxRows,
pricedTickers, priceRows, perfTickers, errors }`.

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

### Reverse direction (optional)

App B can also **read** App A's public, no-auth endpoints to avoid its own FMP
calls — e.g. `GET https://congress.trade/api/analytics/ticker/{TICKER}` returns a
`ref` object (sector, market cap, country, exchange) for that ticker.

### Security

- The import endpoint is **write-authenticated** (bearer token). Do not expose an
  unauthenticated write path; store the token in App B's server env
  (`CONGRESS_TRADE_TOKEN`), never in the browser.
- Reads are public and safe to call from anywhere.

---
