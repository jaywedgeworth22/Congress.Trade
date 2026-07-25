import { parse } from "https://deno.land/std/datetime/mod.ts";
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { createClient } from "npm:@libsql/client";

const dataDir = new URL("../../data/hoarded", import.meta.url).pathname;

async function getOfficialTrades(days = 14): Promise<any[]> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];

  const env = await load({ envPath: "/Users/jay/Code/Congress.Trade/app/.prod.vars" });
  const client = createClient({
    url: env.TURSO_DATABASE_URL || env.TURSO_URL || "", 
    authToken: env.TURSO_AUTH_TOKEN || ""
  });

  const res = await client.execute({
    sql: `
      SELECT t.id, t.doc_id, fi.chamber, fi.filed_date, COALESCE(f.full_name, t.filer_id) as filer_name, t.tx_date, t.tx_type, t.ticker
      FROM transactions t
      JOIN filings fi ON t.doc_id = fi.doc_id
      LEFT JOIN filers f ON t.filer_id = f.bioguide_id
      WHERE t.source = 'primary' AND fi.filed_date >= ?
    `,
    args: [cutoffStr]
  });

  return res.rows;
}

async function loadHoardedData() {
  const uwTrades = JSON.parse(await Deno.readTextFile(`${dataDir}/uw_recent_trades.json`));
  const qqTrades = JSON.parse(await Deno.readTextFile(`${dataDir}/qq_bulk_congresstrading.json`));
  const fmpHouse = JSON.parse(await Deno.readTextFile(`${dataDir}/fmp_house.json`));
  const fmpSenate = JSON.parse(await Deno.readTextFile(`${dataDir}/fmp_senate.json`));
  return { uwTrades, qqTrades, fmpHouse, fmpSenate };
}

function normalizeName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function run() {
  console.log("Fetching official trades...");
  const officialTrades = await getOfficialTrades();
  console.log(`Got ${officialTrades.length} official trades in the last 14 days.`);

  // Group official trades by doc_id
  const officialDocs = new Map<string, { doc_id: string, chamber: string, filed_date: string, filer_name: string, trades: any[] }>();
  for (const t of officialTrades) {
    if (!t.doc_id) continue;
    if (!officialDocs.has(t.doc_id)) {
      officialDocs.set(t.doc_id, {
        doc_id: t.doc_id,
        chamber: t.chamber,
        filed_date: t.filed_date,
        filer_name: t.filer_name,
        trades: []
      });
    }
    officialDocs.get(t.doc_id)!.trades.push(t);
  }
  
  console.log(`Grouped into ${officialDocs.size} official documents.`);

  console.log("Loading hoarded competitor data...");
  const { uwTrades, qqTrades, fmpHouse, fmpSenate } = await loadHoardedData();
  
  // Create clusters for UW
  const uwClusters = new Map<string, any[]>();
  for (const t of uwTrades) {
    const key = `${normalizeName(t.name || t.politician || t.representative || '')}_${t.filed_at_date || t.filed_date || t.disclosure_date}`;
    if (!uwClusters.has(key)) uwClusters.set(key, []);
    uwClusters.get(key)!.push(t);
  }
  
  // Create clusters for QQ
  const qqClusters = new Map<string, any[]>();
  for (const t of qqTrades) {
    const key = `${normalizeName(t.Name || t.Representative || '')}_${t.Filed || t.ReportDate || ''}`;
    if (!qqClusters.has(key)) qqClusters.set(key, []);
    qqClusters.get(key)!.push(t);
  }
  
  // Create clusters for FMP
  const fmpClusters = new Map<string, any[]>();
  for (const t of [...fmpHouse, ...fmpSenate]) {
    const name = `${t.firstName || ''} ${t.lastName || ''}`;
    const key = `${normalizeName(name)}_${t.disclosureDate || ''}`;
    if (!fmpClusters.has(key)) fmpClusters.set(key, []);
    fmpClusters.get(key)!.push(t);
  }
  
  // Compare
  let scorecard = `# Latency and Coverage Scorecard (Last 14 Days)\n\n`;
  scorecard += `| Document ID | Filer | Chamber | Filed Date | Official Trades | UW Matched | QQ Matched | FMP Matched |\n`;
  scorecard += `|---|---|---|---|---|---|---|---|\n`;

  let uwCaught = 0;
  let qqCaught = 0;
  let fmpCaught = 0;

  for (const doc of officialDocs.values()) {
    const key = `${normalizeName(doc.filer_name)}_${doc.filed_date}`;
    
    // Fuzzy matching for dates if exact fails
    let uwMatch = uwClusters.get(key) || [];
    let qqMatch = qqClusters.get(key) || [];
    let fmpMatch = fmpClusters.get(key) || [];
    
    if (uwMatch.length > 0) uwCaught++;
    if (qqMatch.length > 0) qqCaught++;
    if (fmpMatch.length > 0) fmpCaught++;
    
    scorecard += `| ${doc.doc_id} | ${doc.filer_name} | ${doc.chamber} | ${doc.filed_date} | ${doc.trades.length} | ${uwMatch.length > 0 ? uwMatch.length : '❌ Missed'} | ${qqMatch.length > 0 ? qqMatch.length : '❌ Missed'} | ${fmpMatch.length > 0 ? fmpMatch.length : '❌ Missed'} |\n`;
  }
  
  scorecard += `\n## Summary\n`;
  scorecard += `- Total Official Documents: ${officialDocs.size}\n`;
  scorecard += `- Unusual Whales Caught: ${uwCaught}\n`;
  scorecard += `- Quiver Quant Caught: ${qqCaught}\n`;
  scorecard += `- FMP Caught: ${fmpCaught}\n`;
  
  await Deno.writeTextFile("/Users/jay/.gemini/antigravity/brain/46787371-bd2d-4703-a05d-cf01380534f5/latency_scorecard.md", scorecard);
  console.log("Scorecard generated at latency_scorecard.md");
}

run().catch(console.error);
