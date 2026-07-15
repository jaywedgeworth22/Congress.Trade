const URL = 'https://congress.trade/api/admin/query';
const TOKEN = '56c11f2e0c7fa4d019d379fd0b8676199ad1186ad8b09fe5be6a7b2ecbf05060';
async function run() {
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
