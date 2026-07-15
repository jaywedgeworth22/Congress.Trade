import { runPriceRefresh } from './src/prices/service.js';
// We can't easily run it directly from Node.js because it requires the Cloudflare environment
// (D1 binding, KV, trackedFetch etc.).
