const URL = 'https://congress.trade/api/admin/refresh-prices';
const TOKEN = '56c11f2e0c7fa4d019d379fd0b8676199ad1186ad8b09fe5be6a7b2ecbf05060';

async function run() {
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
