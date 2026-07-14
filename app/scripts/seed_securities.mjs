#!/usr/bin/env node
/**
 * seed_securities.mjs — build securities_master seed SQL from the SEC's
 * authoritative ticker list (https://www.sec.gov/files/company_tickers.json).
 * Standalone operator-side maintenance; this file is not bundled into the Worker.
 *
 * Runs on your machine (Node 18+, global fetch). Writes scripts/securities_master.sql,
 * then load it:
 *   node scripts/seed_securities.mjs
 *   npx wrangler d1 execute DB --remote --file=scripts/securities_master.sql
 *
 * The normalizer resolves a parsed ticker against this table (exact symbol, then
 * alias/name). Unresolved tickers still pass through, just at lower confidence.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { trackedOperatorFetch } from './usage-telemetry.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'securities_master.sql');
const SRC = 'https://www.sec.gov/files/company_tickers.json';
// SEC requires a descriptive User-Agent (their fair-access policy).
const UA = 'congress-feed seed (admin contact: you@example.com)';

const esc = (s) => String(s ?? '').replace(/'/g, "''");

const res = await trackedOperatorFetch(
  SRC,
  { headers: { 'User-Agent': UA, Accept: 'application/json' } },
  { provider: 'sec-edgar', service: 'seed-maintenance', operation: 'fetch-company-tickers' },
);
if (!res.ok) {
  console.error(`SEC fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const data = await res.json();
const rows = Object.values(data); // { cik_str, ticker, title }

const seen = new Set();
const values = [];
for (const r of rows) {
  const ticker = String(r.ticker || '').toUpperCase().trim();
  if (!ticker || seen.has(ticker)) continue;
  seen.add(ticker);
  values.push(`('${esc(ticker)}','${esc(r.title)}','[]')`);
}

const sql =
  '-- securities_master seed (SEC company_tickers.json)\n' +
  'BEGIN TRANSACTION;\n' +
  // chunk to keep statements a sane size
  chunk(values, 500)
    .map(
      (c) =>
        'INSERT OR IGNORE INTO securities_master (ticker, name, aliases) VALUES\n' +
        c.join(',\n') +
        ';',
    )
    .join('\n') +
  '\nCOMMIT;\n';

await writeFile(OUT, sql, 'utf8');
console.log(`Wrote ${values.length} tickers -> ${OUT}`);

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
