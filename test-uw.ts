import { config } from 'dotenv';
import { parseUnusualWhalesDisclosureRows } from './app/src/ingestion/fmpDisclosureLatency.ts';
config({ path: '/Users/jay/.secrets/global-api-keys.env' });
const apiKey = process.env.UNUSUALWHALES_API_KEY;

async function run() {
  const res = await fetch(`https://api.unusualwhales.com/api/congress/trades?date=${new Date().toISOString().slice(0, 10)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const data = await res.json();
  const rows = parseUnusualWhalesDisclosureRows(data);
  console.log(JSON.stringify(rows.slice(0, 5), null, 2));
}
run();
