import { createClient } from "npm:@libsql/client";
const db = createClient({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN")!
});
async function run() {
  const rs = await db.execute(`
    SELECT t.filer_id as tx_filer_id, m.canonical_id
    FROM transactions t
    JOIN (
      -- We don't have m in filers anymore. But we can match by name if we stored it?
      -- wait, transactions doesn't have filer_name.
      SELECT '1' as placeholder
    ) dummy
    WHERE t.filer_id LIKE 'MANUAL-%'
    LIMIT 10
  `);
  console.log(rs.rows);
}
run();
