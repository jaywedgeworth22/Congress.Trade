const ADMIN_TOKEN = "56c11f2e0c7fa4d019d379fd0b8676199ad1186ad8b09fe5be6a7b2ecbf05060";
const URL = "https://congress.trade/api/admin/debug-sql";

async function runSql(query: string, params: any[] = []) {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, params })
  });
  
  if (!res.ok) {
    console.error("HTTP error:", res.status, await res.text());
    return;
  }
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

const args = Deno.args;
if (args.length === 0) {
  console.log("Provide SQL query as argument");
  Deno.exit(1);
}

const query = args[0];
console.log("Executing:", query);
await runSql(query);
