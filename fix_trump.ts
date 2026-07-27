import { createClient } from "npm:@libsql/client";
const db = createClient({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN")!
});
async function run() {
  const t1 = await db.execute("UPDATE transactions SET filer_id = 'EXEC-DJT' WHERE filer_id = 'MANUAL-TRUMP'");
  console.log("Transactions updated:", t1.rowsAffected);
  const t2 = await db.execute("UPDATE trades SET filer_id = 'EXEC-DJT' WHERE filer_id = 'MANUAL-TRUMP'");
  console.log("Trades updated:", t2.rowsAffected);
}
run();
