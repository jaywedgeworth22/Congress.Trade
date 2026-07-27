import { createClient } from "npm:@libsql/client";
const db = createClient({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN")!
});
async function run() {
  const rs = await db.execute("SELECT * FROM filers WHERE full_name LIKE '%Trump%'");
  console.table(rs.rows);
  const rs2 = await db.execute("SELECT COUNT(*) FROM transactions WHERE filer_id = 'MANUAL-TRUMP'");
  console.table(rs2.rows);
  const rs3 = await db.execute("SELECT COUNT(*) FROM transactions WHERE filer_name LIKE '%Trump%'");
  console.table(rs3.rows);
}
run();
