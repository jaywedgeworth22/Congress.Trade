import { createClient } from "@libsql/client";
import "dotenv/config";
import fs from "fs/promises";

const db = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

async function main() {
  const count = await db.execute("SELECT count(*) as total FROM filings WHERE source_url IS NOT NULL");
  console.log("Total filings with source_url:", count.rows[0].total);
}
main().catch(console.error);
