import { createClient } from "npm:@libsql/client";
const db = createClient({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN")!
});
async function run() {
  const rs = await db.execute("SELECT id, created_at, tx_date, source FROM transactions WHERE filer_id = 'MANUAL-TRUMP' ORDER BY created_at DESC LIMIT 5");
  console.table(rs.rows);
}
run();
