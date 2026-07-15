const key = process.env.FMP_API_KEY;
async function run() {
  if (!key) { console.error('Set FMP_API_KEY env var'); process.exit(1); }
  const stableUrl = `https://financialmodelingprep.com/api/v3/historical-price-eod/dividend-adjusted?symbol=MSFT&from=2020-01-01&to=2026-07-14&apikey=${key}`;
  const res = await fetch(stableUrl);
  const data = await res.json();
  console.log(`MSFT response keys:`, Object.keys(data));
}
run();
