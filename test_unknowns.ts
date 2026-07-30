import { createClient } from "npm:@libsql/client";
const ADMIN_TOKEN = "***REMOVED***";
const URL = "https://congress.trade/api/admin/debug-sql";
async function runSql(query: string, params: any[] = []): Promise<any[]> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, params })
  });
  const data = await res.json();
  return data.results;
}
async function test() {
  const filings = await runSql("SELECT filer_id FROM filings WHERE doc_id IN ('provider-missing-unusual_whales-senate-unusual_whales-1aqrhkk', 'provider-missing-unusual_whales-senate-unusual_whales-x3f3d7')");
  console.log("Filings:", filings);
}
test().catch(console.error);
