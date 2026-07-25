import { createClient } from "npm:@libsql/client";

const client = createClient({
  url: Deno.env.get("TURSO_DATABASE_URL") || Deno.env.get("TURSO_URL") || "",
  authToken: Deno.env.get("TURSO_AUTH_TOKEN") || "",
});

function escapeCsv(val) {
  if (val == null) return "";
  const s = String(val);
  return `"${s.replace(/"/g, '""')}"`;
}

async function main() {
  console.log("Fetching all transactions...");
  const res = await client.execute("SELECT t.id, t.doc_id, COALESCE(fi.chamber, 'unknown') as chamber, t.tx_date, t.tx_type, t.ticker, COALESCE(f.full_name, t.filer_id) as member FROM transactions t LEFT JOIN filings fi ON t.doc_id = fi.doc_id LEFT JOIN filers f ON t.filer_id = f.bioguide_id");
  console.log(`Fetched ${res.rows.length} rows.`);

  let csv = "id,doc_id,chamber,tx_date,type,ticker,member\n";
  for (const row of res.rows) {
    csv += `${escapeCsv(row.id)},${escapeCsv(row.doc_id)},${escapeCsv(row.chamber)},${escapeCsv(row.tx_date)},${escapeCsv(row.tx_type)},${escapeCsv(row.ticker)},${escapeCsv(row.member)}\n`;
  }
  
  await Deno.writeTextFile("../data/hoarded/our_trades.csv", csv);
  console.log("Wrote our_trades.csv");
}

main().catch(console.error);
