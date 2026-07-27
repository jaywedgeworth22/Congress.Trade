import { createClient } from "npm:@libsql/client";
import "npm:dotenv/config";

const db = createClient({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN")!,
});

async function run() {
  const sample = await db.execute({
    sql: `SELECT raw_object_key FROM filings WHERE doc_id = 'H-2026-20034168'`,
    args: []
  });
  console.log(sample.rows);
}
run();
