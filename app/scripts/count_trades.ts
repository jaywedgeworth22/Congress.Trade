import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { createClient } from "npm:@libsql/client/web";
import { resolveSecret } from "../src/secrets/infisical.ts";

async function run() {
  const envVars = await load({ envPath: ".dev.vars", export: true });
  for (const [k, v] of Object.entries(envVars)) {
    Deno.env.set(k, v);
  }
  const mockEnv = envVars as any;
  const tursoUrl = (await resolveSecret(mockEnv, "TURSO_DATABASE_URL")).value;
  const tursoToken = (await resolveSecret(mockEnv, "TURSO_AUTH_TOKEN")).value;
  const db = createClient({ url: tursoUrl!, authToken: tursoToken! });
  const countRes = await db.execute("SELECT COUNT(*) as c FROM transactions");
  console.log("Total trades in DB:", countRes.rows[0].c);
  
  const sourcesRes = await db.execute("SELECT source, COUNT(*) as c FROM transactions GROUP BY source");
  for (const row of sourcesRes.rows) {
    console.log(`Source: ${row.source} -> ${row.c}`);
  }
}
run().catch(console.error);
