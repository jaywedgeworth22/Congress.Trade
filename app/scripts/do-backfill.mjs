const TOKEN = process.env.CONGRESS_TRADE_ADMIN_TOKEN;
const URL = process.env.CONGRESS_TRADE_API_URL || 'https://congress.trade/api/admin/refresh-prices';

async function run() {
  if (!TOKEN) { console.error('Set CONGRESS_TRADE_ADMIN_TOKEN env var'); process.exit(1); }
  let i = 1;
  while (true) {
    console.log(`\nIteration ${i}...`);
    const start = Date.now();
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ max: 50, dryRun: false })
    });
    const data = await res.json();
    console.log(`Priced: ${data.tickersPriced || 0} in ${Date.now() - start}ms`);
    console.log(JSON.stringify(data, null, 2));
    if (data.tickersPriced === 0) break;
    i++;
  }
}
run();
