const TOKEN = process.env.CONGRESS_TRADE_ADMIN_TOKEN;
const URL = process.env.CONGRESS_TRADE_API_URL || 'https://congress.trade/api/admin/query';
async function run() {
  if (!TOKEN) { console.error('Set CONGRESS_TRADE_ADMIN_TOKEN env var'); process.exit(1); }
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql: "SELECT * FROM transactions WHERE ticker = 'BYND';" })
  });
  const text = await res.text();
  console.log(text);
}
run();
