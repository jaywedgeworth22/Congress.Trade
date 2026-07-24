import { config } from 'dotenv';
config({ path: '/Users/jay/.secrets/global-api-keys.env' });
import { pollOgeExecutive } from './src/ingestion/ogeSource.ts';
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
      try {
        await client.execute({
          sql: `INSERT INTO disclosure_latency_candidates
             (doc_id, provider, chamber, source_url, filed_date, filer_name,
              congress_first_seen_at, status, attempts, created_at, updated_at)
           VALUES (?, 'unusual_whales', ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
           ON CONFLICT(doc_id, provider) DO UPDATE SET
             filed_date = CASE WHEN filed_date = '' THEN excluded.filed_date ELSE filed_date END,
             congress_first_seen_at = MIN(congress_first_seen_at, excluded.congress_first_seen_at),
             updated_at = excluded.updated_at`,
          args: [filing.docId, filing.chamber, filing.sourceUrl, filing.filedDate ?? '', filing.filerName, now, now, now]
        });
        inserted++;
      } catch (err) {
        console.error(err);
      }
    }
  }
  console.log(`Inserted ${inserted} executive candidates`);
}
run().catch(console.error);
