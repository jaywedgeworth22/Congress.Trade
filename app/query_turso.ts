import { createClient } from "@libsql/client";
const client = createClient({
  url: process.env.TURSO_DB_URL,
  authToken: process.env.TURSO_DB_AUTH_TOKEN
});
const res = await client.execute("SELECT status, COUNT(*) FROM deno_runtime_queue GROUP BY status");
console.log(res.rows);
