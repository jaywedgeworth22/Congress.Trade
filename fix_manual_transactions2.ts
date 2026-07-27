import { createClient } from "npm:@libsql/client";
const db = createClient({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN")!
});
async function run() {
  const rs = await db.execute(`
    SELECT filer_id, COUNT(*)
    FROM transactions
    WHERE filer_id LIKE 'MANUAL-%'
    GROUP BY filer_id
  `);
  console.table(rs.rows);
}
run();
