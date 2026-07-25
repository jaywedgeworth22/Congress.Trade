import { fetchInfisicalSecrets } from "./src/shared/infisical.ts";
import { createClient } from "@libsql/client";
import "dotenv/config"; // will load .dev.vars

async function main() {
  const secrets = await fetchInfisicalSecrets();
  const dbUrl = secrets["TURSO_DATABASE_URL"];
  const dbToken = secrets["TURSO_AUTH_TOKEN"];
  
  if (!dbUrl || !dbToken) {
    throw new Error("Missing Turso secrets in Infisical");
  }

  const db = createClient({
    url: dbUrl,
    authToken: dbToken,
  });

  const res = await db.execute("SELECT count(*) as count FROM filings WHERE source_url IS NOT NULL");
  console.log("Total filings with source_url:", res.rows[0].count);
  
  const resPtr = await db.execute("SELECT count(*) as count FROM filings WHERE source_url IS NOT NULL AND form_type = 'PTR'");
  console.log("Total PTR filings with source_url:", resPtr.rows[0].count);
}
main().catch(console.error);
