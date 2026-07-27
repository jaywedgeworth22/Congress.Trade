import { createClient } from "npm:@libsql/client";
const db = createClient({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN")!
});
async function run() {
  const rs = await db.execute(`
    SELECT f1.bioguide_id, f1.full_name, f2.bioguide_id as canonical_id
    FROM filers f1
    LEFT JOIN filers f2 ON LOWER(f1.full_name) = LOWER(f2.full_name) AND f2.bioguide_id NOT LIKE 'MANUAL-%'
    WHERE f1.bioguide_id LIKE 'MANUAL-%'
    LIMIT 10
  `);
  console.table(rs.rows);
}
run();
