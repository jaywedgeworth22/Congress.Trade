import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { createClient } from "npm:@libsql/client";

async function main() {
  const env = await load({ envPath: "/Users/jay/Code/Congress.Trade/app/.prod.vars" });
  const client = createClient({
    url: env.TURSO_DATABASE_URL || env.TURSO_URL || "", 
    authToken: env.TURSO_AUTH_TOKEN || ""
  });

  const res = await client.execute("SELECT filer_id, count(*) as count FROM transactions WHERE doc_id LIKE 'COMPETITOR-%' GROUP BY filer_id");
  console.log(res.rows);
}

main().catch(console.error);
