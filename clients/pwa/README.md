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
npm ci
npm run dev
```

The PWA is intentionally same-origin with the Worker because browser sessions use
HTTP-only cookies and the Worker does not expose CORS headers. Leave
`NEXT_PUBLIC_API_BASE_URL` blank in deployed builds. For local live-data work,
front Next.js and `wrangler dev` with one reverse proxy origin that sends `/api/*`
and `/auth/*` to Wrangler and all other paths to Next.js.

## Verification

```bash
npm run typecheck
npm test
npm run build
```
