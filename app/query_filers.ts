import { createClient } from "npm:@libsql/client";

const db = createClient({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN")!
});

const res = await db.execute(`
  SELECT full_name, COUNT(*) as count 
  FROM filers 
  GROUP BY full_name 
  HAVING count > 1 
  ORDER BY count DESC 
  LIMIT 20
`);
console.log(res.rows);
