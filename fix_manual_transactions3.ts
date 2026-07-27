import { createClient } from "npm:@libsql/client";
const db = createClient({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN")!
});
async function run() {
  const rs = await db.execute(`
    SELECT t.filer_id, COUNT(t.id) as count
    FROM transactions t
    LEFT JOIN filers f ON t.filer_id = f.bioguide_id
    WHERE t.filer_id LIKE 'MANUAL-%' AND f.bioguide_id IS NULL
    GROUP BY t.filer_id
  `);
  console.table(rs.rows);
}
run();
