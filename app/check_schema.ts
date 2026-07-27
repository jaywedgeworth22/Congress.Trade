import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { createClient } from "npm:@libsql/client";
const env = await load({ envPath: "/Users/jay/Code/Congress.Trade/app/.prod.vars" });
const client = createClient({url: env.TURSO_DATABASE_URL || env.TURSO_URL || "", authToken: env.TURSO_AUTH_TOKEN || ""});
const r1 = await client.execute("PRAGMA table_info(transactions)");
console.log("transactions:", r1.rows.map(r => r.name));
const r2 = await client.execute("PRAGMA table_info(filings)");
console.log("filings:", r2.rows.map(r => r.name));
