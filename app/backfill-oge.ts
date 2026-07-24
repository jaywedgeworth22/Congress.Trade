import { config } from 'dotenv';
config({ path: '/Users/jay/.secrets/global-api-keys.env' });
import { pollOgeExecutive } from './src/ingestion/ogeSource.ts';
import { insertDisclosureLatencyCandidate } from './src/ingestion/fmpDisclosureLatency.ts';
import { createClient } from "@libsql/client";

async function run() {
  const client = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const env = { DB: client } as any;
  const filings = await pollOgeExecutive(env, fetch);
  console.log(`Found ${filings.length} OGE filings`);
  const now = new Date().toISOString();
  let inserted = 0;
  for (const filing of filings) {
    if (filing.chamber === 'executive') {
      await insertDisclosureLatencyCandidate(env, filing, now);
      inserted++;
    }
  }
  console.log(`Inserted ${inserted} executive candidates`);
}
run().catch(console.error);
