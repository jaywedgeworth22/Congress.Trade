import { createClient } from "npm:@libsql/client";

async function run() {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const res = await db.execute("SELECT id, name, chamber FROM members WHERE name LIKE '%Manual%' OR name LIKE '%manual%' LIMIT 10");
  console.log("MEMBERS WITH MANUAL IN NAME:", res.rows);
  const res2 = await db.execute("SELECT doc_id, filer_id FROM filings WHERE filer_id LIKE '%manual%' LIMIT 5");
  console.log("FILINGS WITH MANUAL FILER:", res2.rows);
}
run();
