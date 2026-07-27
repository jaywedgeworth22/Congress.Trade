import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { createClient } from "npm:@libsql/client";

async function main() {
  const env = await load({ envPath: ".prod.vars" });
  const client = createClient({
    url: env.TURSO_DATABASE_URL || "", 
    authToken: env.TURSO_AUTH_TOKEN || ""
  });

  const result = await client.execute(`
    SELECT DISTINCT doc_id
    FROM transactions
    WHERE ticker IS NULL AND asset_name = '(unknown)'
  `);
  
  console.log("Docs to reprocess:", result.rows.length);
  const docIds = result.rows.map(r => r[0]); 
  Deno.writeTextFileSync("bad_docs.json", JSON.stringify(docIds));
}
main().catch(console.error);
