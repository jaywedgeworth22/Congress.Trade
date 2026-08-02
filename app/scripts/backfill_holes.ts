import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { createClient } from "npm:@libsql/client";

async function main() {
  const env = await load({ envPath: "/Users/jay/Code/Congress.Trade/app/.prod.vars" });
  const client = createClient({
    url: env.TURSO_DATABASE_URL || env.TURSO_URL || "", 
    authToken: env.TURSO_AUTH_TOKEN || ""
  });

  const holesJson = await Deno.readTextFile("/Users/jay/.gemini/antigravity/brain/46787371-bd2d-4703-a05d-cf01380534f5/data_holes.json");
  const holes = JSON.parse(holesJson);

  console.log(`Loaded ${holes.length} missing trades.`);

  const txBatch = [];
  
  for (const h of holes) {
    let filerId = `MANUAL-${h.lastName.toUpperCase()}`;
    if (h.lastName.toLowerCase() === 'trump') filerId = 'EXEC-DJT';
    if (h.lastName.toLowerCase() === 'wright') filerId = 'EXEC-CWRIGHT';
    if (h.lastName.toLowerCase() === 'mccormick') filerId = 'EXEC-MCCORMICK';
    if (h.lastName.toLowerCase() === 'mcmahon') filerId = 'EXEC-MCMAHON';
    if (h.lastName.toLowerCase() === 'bessent') filerId = 'EXEC-BESSENT';

    let txType = 'buy';
    if (h.type === 'buy') txType = 'purchase';
    if (h.type === 'sell') txType = 'sale_full';
    if (h.type === 'exchange') txType = 'exchange';

    const docId = `COMPETITOR-${h.provider}-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();

    txBatch.push({
      sql: `INSERT OR IGNORE INTO transactions (
        id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type, tx_type, amount_min, amount_max, is_option, cap_gains_over_200, raw_text, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        docId,
        filerId,
        h.date,
        'unknown',
        h.ticker || 'unknown',
        h.ticker || null,
        'stock',
        txType,
        1001,
        15000,
        0,
        0,
        JSON.stringify(h.raw),
        'competitor_backfill',
        new Date().toISOString()
      ]
    });
  }

  console.log(`Executing ${txBatch.length} insertions...`);
  
  // Turso batch is limited to some number of statements (often 100 or 1000). Let's chunk to 100
  let successCount = 0;
  for (let i = 0; i < txBatch.length; i += 100) {
    const chunk = txBatch.slice(i, i + 100);
    await client.batch(chunk, "write");
    successCount += chunk.length;
    console.log(`Inserted ${successCount} / ${txBatch.length}`);
  }
  
  console.log("Backfill complete.");
}

main().catch(console.error);
