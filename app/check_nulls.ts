import { createDb } from "./src/shared/db.ts";

async function main() {
  const db = createDb({
    TURSO_URL: Deno.env.get("TURSO_URL"),
    TURSO_AUTH_TOKEN: Deno.env.get("TURSO_AUTH_TOKEN"),
  });
  
  const result = await db.execute(`
    SELECT COUNT(DISTINCT doc_id) as c
    FROM transactions
    WHERE ticker IS NULL AND asset_name = '(unknown)'
  `);
  
  console.log("Distinct doc_ids with (unknown) asset_name:", result.rows[0].c);

  const sample = await db.execute(`
    SELECT doc_id, asset_name, ticker, source 
    FROM transactions
    WHERE ticker IS NULL AND asset_name = '(unknown)'
    LIMIT 10
  `);
  console.log(sample.rows);
}

main().catch(console.error);
