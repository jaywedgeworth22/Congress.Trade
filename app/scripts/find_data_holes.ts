import { parse } from "https://deno.land/std/datetime/mod.ts";

const dataDir = new URL("../../data/hoarded", import.meta.url).pathname;

async function getOfficialTrades() {
  const CACHE_FILE = "../data/hoarded/our_trades.csv";
  console.log("Loading official trades from our_trades.csv...");
  const text = await Deno.readTextFile(CACHE_FILE);
  const { parse } = await import("https://deno.land/std@0.224.0/csv/mod.ts");
  const data = parse(text, { skipFirstRow: true });
  
  return data.map(row => ({
    filer_name: row.member,
    ticker: row.ticker,
    tx_date: row.tx_date,
    tx_type: row.type,
    chamber: row.chamber,
    doc_id: row.doc_id
  }));
}

async function loadHoardedData() {
  const uwTrades = JSON.parse(await Deno.readTextFile(`${dataDir}/uw_recent_trades.json`));
  const qqTrades = JSON.parse(await Deno.readTextFile(`${dataDir}/qq_bulk_congresstrading.json`));
  const fmpHouse = JSON.parse(await Deno.readTextFile(`${dataDir}/fmp_house.json`));
  const fmpSenate = JSON.parse(await Deno.readTextFile(`${dataDir}/fmp_senate.json`));
  return { uwTrades, qqTrades, fmpHouse, fmpSenate };
}

function extractLastName(name: string) {
  if (!name) return '';
  const parts = name.split(',')[0].split(' ');
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].toLowerCase().replace(/[^a-z]/g, '');
    if (p && !['jr', 'sr', 'md', 'ii', 'iii', 'iv'].includes(p)) {
      return p;
    }
  }
  return '';
}

function normalizeTicker(tk: string) {
  if (!tk) return '';
  tk = tk.toUpperCase();
  if (tk === 'NONE' || tk === 'N/A' || tk === 'NA') return '';
  return tk;
}

function normalizeType(typeStr: string) {
  if (!typeStr) return 'other';
  const t = typeStr.toLowerCase();
  if (t.includes('buy') || t.includes('purchase') || t === 'p') return 'buy';
  if (t.includes('sell') || t.includes('sale') || t === 's' || t === 's (partial)') return 'sell';
  if (t.includes('exchange') || t === 'e') return 'exchange';
  return 'other';
}

async function run() {
  const officialTrades = await getOfficialTrades();
  console.log(`Got ${officialTrades.length} official trades.`);

  const officialMap = new Map<string, any[]>();
  
  for (const t of officialTrades) {
    const lastName = extractLastName(t.filer_name);
    const ticker = normalizeTicker(t.ticker);
    const date = t.tx_date;
    const type = normalizeType(t.tx_type);
                 
    const key = `${lastName}_${ticker}_${date}_${type}`;
    if (!officialMap.has(key)) officialMap.set(key, []);
    officialMap.get(key)!.push(t);
  }

  const { uwTrades, qqTrades, fmpHouse, fmpSenate } = await loadHoardedData();
  
  const fiveYearsAgo = new Date();
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  const cutoffDate = fiveYearsAgo.toISOString().split('T')[0];

  const holes: any[] = [];
  
  function checkTrade(provider: string, rawName: string, ticker: string, date: string, typeStr: string, rawObj: any) {
    if (!date || date < cutoffDate) return; 
    
    const lastName = extractLastName(rawName);
    const tk = normalizeTicker(ticker);
    const type = normalizeType(typeStr);
                 
    const exactKey = `${lastName}_${tk}_${date}_${type}`;
    if (officialMap.has(exactKey)) return; 
    
    let found = false;
    const d = new Date(date);
    for (let offset = -2; offset <= 2; offset++) {
      const fd = new Date(d);
      fd.setDate(fd.getDate() + offset);
      const fdStr = fd.toISOString().split('T')[0];
      const fuzzyKey = `${lastName}_${tk}_${fdStr}_${type}`;
      if (officialMap.has(fuzzyKey)) {
        found = true;
        break;
      }
    }
    
    if (!found) {
      holes.push({
        provider,
        lastName,
        rawName,
        ticker: tk,
        date,
        type,
        raw: rawObj
      });
    }
  }

  for (const t of uwTrades) {
    checkTrade('UnusualWhales', t.name || t.reporter, t.ticker, t.transaction_date, t.txn_type || t.type || 'buy', t);
  }
  for (const t of qqTrades) {
    checkTrade('QuiverQuant', t.Representative, t.Ticker, t.TransactionDate, t.Transaction, t);
  }
  for (const t of fmpHouse) {
    checkTrade('FMP_House', `${t.firstName} ${t.lastName}`, t.symbol, t.transactionDate, t.type, t);
  }
  for (const t of fmpSenate) {
    checkTrade('FMP_Senate', `${t.firstName} ${t.lastName}`, t.symbol, t.transactionDate, t.type, t);
  }
  
  console.log(`Found ${holes.length} potential holes in our data!`);
  await Deno.writeTextFile("/Users/jay/.gemini/antigravity/brain/46787371-bd2d-4703-a05d-cf01380534f5/data_holes.json", JSON.stringify(holes, null, 2));
  
  const groupedHoles = new Map<string, number>();
  for (const h of holes) {
    const key = `${h.provider}: ${h.lastName} (${h.ticker})`;
    groupedHoles.set(key, (groupedHoles.get(key) || 0) + 1);
  }
  
  let md = `# Data Holes Report\n\nWe found ${holes.length} trades from competitors in the last 5 years that we don't have.\n\n`;
  const sorted = [...groupedHoles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
  
  md += `## Top 50 Missing Clusters\n`;
  for (const [key, count] of sorted) {
    md += `- **${key}**: ${count} missing trades\n`;
  }
  
  await Deno.writeTextFile("/Users/jay/.gemini/antigravity/brain/46787371-bd2d-4703-a05d-cf01380534f5/data_holes_report.md", md);
  console.log("Wrote data_holes_report.md");
}

run().catch(console.error);
