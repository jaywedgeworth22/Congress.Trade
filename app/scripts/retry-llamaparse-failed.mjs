#!/usr/bin/env node

/**
 * app/scripts/retry-llamaparse-failed.mjs
 * 
 * Retries LlamaParse for the documents that failed during the agreement cascade.
 * It uses the admin bakeoff API to re-run the extraction.
 * 
 * Usage:
 *   ADMIN_TOKEN=xxx BASE=https://congress.trade node app/scripts/retry-llamaparse-failed.mjs
 */

const BASE = process.env.BASE || 'https://congress.trade';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  console.error("Error: ADMIN_TOKEN environment variable is required.");
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${ADMIN_TOKEN}`,
  'Content-Type': 'application/json',
};

const docIds = [
  "E-2025-donald-j-trump-08-12-2025-278t",
  "E-2025-donald-j-trump-08-12-2025-278t-2-amended",
  "E-2025-donald-j-trump-08-12-2025-278t-3",
  "E-2025-donald-j-trump-10-20-2025-278-t",
  "E-2025-donald-j-trump-10-20-2025-278-t-2",
  "E-2025-donald-j-trump-11-14-2025-278-t",
  "E-2025-donald-j-trump-12-18-2025-278-t",
  "E-2026-donald-j-trump-06-25-2026-278t",
  "E-2026-donald-j-trump-06-25-2026-278t-2",
  "E-2026-donald-j-trump-1-14-2026-278t",
  "E-2026-donald-j-trump-2-26-2026-278-t-1",
  "E-2026-donald-j-trump-2-26-2026-278-t-2",
  "E-2026-donald-j-trump-4-20-2026-278t",
  "E-2026-trump-donald-j-05-08-2026-278t",
  "E-2026-trump-donald-j-05-08-2026-278t-2"
];

async function runLlamaParse(docId) {
  // We use the dry-run API which stores the extraction in extraction_runs as 'bakeoff'
  // but doesn't autonomously publish. This allows manual review in the dashboard.
  const models = { a: { provider: 'llamaparse', model: 'llamaparse:fast' } };
  const res = await fetch(`${BASE}/api/admin/benchmark/dry-run/${docId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ models })
  });
  if (!res.ok) throw new Error(`Failed on ${docId}: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function main() {
  console.log(`Starting LlamaParse retry against ${BASE}...`);
  console.log(`Found ${docIds.length} failed LlamaParse docs to retry.\n`);

  let successCount = 0;
  let failCount = 0;

  for (const docId of docIds) {
    try {
      process.stdout.write(`Retrying ${docId}... `);
      const result = await runLlamaParse(docId);
      console.log(`✅ Result: ${result.outcome}`);
      successCount++;
    } catch (err) {
      console.log(`❌ Error: ${err.message}`);
      failCount++;
    }
    // sleep 2 seconds to avoid LlamaParse rate limits
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  console.log('\n========================================');
  console.log(`Finished. Success: ${successCount}, Failed: ${failCount}`);
  console.log('You can review the new extractions in the Admin Dashboard.');
}

main().catch(console.error);
