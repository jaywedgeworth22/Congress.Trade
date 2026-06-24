# Congress.Trade PWA

Phone-first Next.js client for the shared backend API.

## Contract

- Reads from `/api/client/v1/bootstrap` and `/api/client/v1/feed`.
- Writes through `/api/client/v1/commands`.
- Uses browser session cookies with `credentials: "include"`.
- Does not scrape, calculate, store provider secrets, run MCP tools, or call
  admin/backfill routes directly.

## Local Development

```bash
cd clients/pwa
npm install
npm run dev
```

Set `NEXT_PUBLIC_API_BASE_URL=https://congress.trade` when running on a different
origin from the Worker API. Same-origin deploys can leave it blank.
