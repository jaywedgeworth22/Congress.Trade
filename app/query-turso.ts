import { createClient } from "@libsql/client";
import { config } from 'dotenv';
config({ path: '/Users/jay/.secrets/global-api-keys.env' });
const client = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
async function run() {
  const rs = await client.execute(`
    UPDATE disclosure_provider_observations
    SET chamber = 'executive'
    WHERE filer_name = 'Donald J Trump' AND provider = 'unusual_whales' AND chamber = 'house';
  `);
  console.log('Updated rows:', rs.rowsAffected);
}
run().catch(console.error);
