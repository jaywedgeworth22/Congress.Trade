import { createDb } from "./src/shared/db.ts";

async function main() {
  const db = createDb({
    TURSO_URL: Deno.env.get("TURSO_URL"),
    TURSO_AUTH_TOKEN: Deno.env.get("TURSO_AUTH_TOKEN"),
  });
  
  const result = await db.execute(`
    SELECT source, COUNT(*) as count
    FROM transactions
    WHERE ticker IN ('NONE', '--', 'N/A', 'NA', 'NULL', '—')
    GROUP BY source
  `);
  
  console.log("Sources with placeholder tickers:");
  console.log(result.rows);
  
  const sample = await db.execute(`
    SELECT id, doc_id, asset_name, ticker, source 
    FROM transactions
    WHERE ticker IN ('NONE', '--', 'N/A', 'NA', 'NULL', '—')
    LIMIT 10
  `);
  console.log("Sample records:");
  console.log(sample.rows);
}

main().catch(console.error);
