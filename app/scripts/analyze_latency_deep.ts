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
      SELECT t.id, t.doc_id, fi.chamber, fi.filed_date, fi.first_seen_at as filing_created_at, COALESCE(f.full_name, t.filer_id) as filer_name, t.tx_date, t.tx_type, t.ticker
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
  const officialTrades = await getOfficialTrades();
  
  const officialDocs = new Map<string, any>();
  for (const t of officialTrades) {
    if (!t.doc_id) continue;
    if (!officialDocs.has(t.doc_id)) {
      officialDocs.set(t.doc_id, {
        doc_id: t.doc_id,
        chamber: t.chamber,
        filed_date: t.filed_date,
        filing_created_at: t.filing_created_at,
        filer_name: t.filer_name,
        trades: []
      });
    }
    officialDocs.get(t.doc_id)!.trades.push(t);
  }
  
  const { uwTrades, qqTrades, fmpHouse, fmpSenate } = await loadHoardedData();
  
  // Cutoff date for filtering competitor feeds
  const days = 14;
  const cutoffDateObj = new Date();
  cutoffDateObj.setDate(cutoffDateObj.getDate() - days);
  const cutoffStr = cutoffDateObj.toISOString().split('T')[0];
  
  // Create clusters for UW
  const uwClusters = new Map<string, any[]>();
  const uwRecent = [];
  for (const t of uwTrades) {
    const filedDate = t.filed_at_date || t.filed_date || t.disclosure_date;
    const key = `${normalizeName(t.name || t.politician || t.representative || '')}_${filedDate}`;
    if (!uwClusters.has(key)) uwClusters.set(key, []);
    uwClusters.get(key)!.push(t);
    if (filedDate >= cutoffStr) uwRecent.push(t);
  }
  
  // Create clusters for QQ
  const qqClusters = new Map<string, any[]>();
  const qqRecent = [];
  for (const t of qqTrades) {
    const filedDate = t.Filed || t.ReportDate || '';
    const key = `${normalizeName(t.Name || t.Representative || '')}_${filedDate}`;
    if (!qqClusters.has(key)) qqClusters.set(key, []);
    qqClusters.get(key)!.push(t);
    if (filedDate >= cutoffStr) qqRecent.push(t);
  }
  
  // Create clusters for FMP
  const fmpClusters = new Map<string, any[]>();
  const fmpRecent = [];
  for (const t of [...fmpHouse, ...fmpSenate]) {
    const name = `${t.firstName || ''} ${t.lastName || ''}`;
    const filedDate = t.disclosureDate || '';
    const key = `${normalizeName(name)}_${filedDate}`;
    if (!fmpClusters.has(key)) fmpClusters.set(key, []);
    fmpClusters.get(key)!.push(t);
    if (filedDate >= cutoffStr) fmpRecent.push(t);
  }
  
  // Create official clusters for reverse lookup
  const officialClusters = new Set<string>();
  for (const doc of officialDocs.values()) {
    officialClusters.add(`${normalizeName(doc.filer_name)}_${doc.filed_date}`);
  }
  
  let uwUnique = 0;
  let qqUnique = 0;
  let fmpUnique = 0;
  
  // Reverse Lookup: What did they find that we missed?
  const missedByUs = new Set<string>();
  
  for (const t of uwRecent) {
    const filedDate = t.filed_at_date || t.filed_date || t.disclosure_date;
    const key = `${normalizeName(t.name || '')}_${filedDate}`;
    if (!officialClusters.has(key)) { uwUnique++; missedByUs.add(`UW: ${t.name} on ${filedDate}`); }
  }
  for (const t of qqRecent) {
    const filedDate = t.Filed || t.ReportDate || '';
    const key = `${normalizeName(t.Name || '')}_${filedDate}`;
    if (!officialClusters.has(key)) { qqUnique++; missedByUs.add(`QQ: ${t.Name} on ${filedDate}`); }
  }
  for (const t of fmpRecent) {
    const name = `${t.firstName || ''} ${t.lastName || ''}`;
    const filedDate = t.disclosureDate || '';
    const key = `${normalizeName(name)}_${filedDate}`;
    if (!officialClusters.has(key)) { fmpUnique++; missedByUs.add(`FMP: ${name} on ${filedDate}`); }
  }
  
  console.log("---- Did they find any which we didn't find? ----");
  console.log(`UW Unique Trades: ${uwUnique}`);
  console.log(`QQ Unique Trades: ${qqUnique}`);
  console.log(`FMP Unique Trades: ${fmpUnique}`);
  console.log("Details of what we might have missed:");
  for (const m of missedByUs) {
    console.log("  - " + m);
  }
  
  console.log("\n---- Latency Comparison (When available) ----");
  for (const doc of officialDocs.values()) {
    const key = `${normalizeName(doc.filer_name)}_${doc.filed_date}`;
    const qqMatch = qqClusters.get(key) || [];
    const uwMatch = uwClusters.get(key) || [];
    
    // Check QQ Quiver_Upload_Time vs our fi.created_at
    if (qqMatch.length > 0) {
      const qqUpload = qqMatch[0].Quiver_Upload_Time; // usually a date like "2026-07-21"
      console.log(`[QQ] ${doc.filer_name} on ${doc.filed_date}:`);
      console.log(`  Our Ingest: ${doc.filing_created_at}`);
      console.log(`  QQ Upload:  ${qqUpload}`);
    }
  }
  
  // UW and FMP do not expose upload times
  console.log("\n(Note: UW and FMP APIs do not expose exact upload/ingest timestamps for their trades, so we can't reliably compare latency down to the hour for them, only the day they processed it, which is often the same day as the filing date).");
}

run().catch(console.error);
