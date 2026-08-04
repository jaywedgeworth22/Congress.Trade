import { parse } from "https://deno.land/std/datetime/mod.ts";
import { createClient } from "npm:@libsql/client/web";
import { D1DatabaseShim } from "../src/deno/shims.ts";
import { generateTradeHash } from "../src/ingestion/tradeLatency.ts";
import { persistTransactions } from "../src/extraction/normalizer.ts";
import type { Env, Transaction } from "../src/shared/types.ts";
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { resolveSecret } from "../src/secrets/infisical.ts";
import {
  assetNameFromCompetitorPayload,
  resolveExecutiveFilerIdFromName,
} from "../src/shared/executiveIdentity.ts";

const dataDir = new URL("../../data/hoarded", import.meta.url).pathname;

async function getEnv(): Promise<Env> {
  const envVars = await load({ envPath: ".dev.vars", export: true });
  
  // Set env vars so resolveSecret can find Infisical creds
  for (const [k, v] of Object.entries(envVars)) {
    Deno.env.set(k, v);
  }

  // resolve secrets
  const mockEnv = envVars as unknown as Env;
  const tursoUrl = (await resolveSecret(mockEnv, "TURSO_DATABASE_URL")).value;
  const tursoToken = (await resolveSecret(mockEnv, "TURSO_AUTH_TOKEN")).value;

  if (!tursoUrl) throw new Error("Could not resolve TURSO_DATABASE_URL");

  const libsqlClient = createClient({
    url: tursoUrl,
    authToken: tursoToken,
  });
  const db = new D1DatabaseShim(libsqlClient);
  return { DB: db } as unknown as Env;
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

async function loadHoardedData() {
  const uwTrades = JSON.parse(await Deno.readTextFile(`${dataDir}/uw_recent_trades.json`));
  const qqTrades = JSON.parse(await Deno.readTextFile(`${dataDir}/qq_bulk_congresstrading.json`));
  const fmpHouse = JSON.parse(await Deno.readTextFile(`${dataDir}/fmp_house.json`));
  const fmpSenate = JSON.parse(await Deno.readTextFile(`${dataDir}/fmp_senate.json`));
  
  let trumpTrades: any[] = [];
  try {
    const raw = await Deno.readTextFile(`${dataDir}/trump_trades.json`);
    try {
      trumpTrades = JSON.parse(raw);
    } catch {
      // Try stream of objects
      trumpTrades = JSON.parse("[" + raw.replace(/\}\s*\{/g, "},{") + "]");
    }
  } catch (e) {
    console.warn("Could not load trump_trades.json");
  }

  return { uwTrades, qqTrades, fmpHouse, fmpSenate, trumpTrades };
}

async function run() {
  const env = await getEnv();
  
  // 1. Get all official trades from DB to compare against
  console.log("Fetching existing trades from DB...");
  const dbRows = await env.DB.prepare("SELECT f.full_name as filer_name, t.ticker, t.tx_date, t.tx_type FROM transactions t JOIN filers f ON t.filer_id = f.bioguide_id").all<{
    filer_name: string; ticker: string; tx_date: string; tx_type: string;
  }>();
  
  const officialMap = new Set<string>();
  for (const t of dbRows.results) {
    const lastName = extractLastName(t.filer_name);
    const ticker = (t.ticker || '').toUpperCase();
    const date = t.tx_date;
    const typeStr = (t.tx_type || '');
    const tStr = (typeStr || '').toLowerCase();
    const type = tStr.includes('buy') || tStr.includes('purchase') ? 'buy' :
                 tStr.includes('sell') || tStr.includes('sale') ? 'sell' : 'exchange';
                 
    officialMap.add(`${lastName}_${ticker}_${date}_${type}`);
  }
  console.log(`Loaded ${officialMap.size} existing trades into lookup map.`);

  // 2. Load competitor data
  const { uwTrades, qqTrades, fmpHouse, fmpSenate, trumpTrades } = await loadHoardedData();
  
  const fiveYearsAgo = new Date();
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  const cutoffDate = fiveYearsAgo.toISOString().split('T')[0];

  const novelTrades: Transaction[] = [];
  const novelSet = new Set<string>();
  
  const nowStr = new Date().toISOString();

  function processTrade(provider: string, rawName: string, chamber: 'house' | 'senate' | 'executive', ticker: string, date: string, typeStr: string, rawObj: any) {
    if (!date || date < cutoffDate) return; 
    
    const tk = (ticker || '').toUpperCase();
    if (!tk) return; // Need ticker

    const lastName = extractLastName(rawName);
    const tStr = (typeStr || '').toLowerCase();
    const type = tStr.includes('buy') || tStr.includes('purchase') ? 'buy' :
                 tStr.includes('sell') || tStr.includes('sale') ? 'sell' : 'exchange';
                 
    const exactKey = `${lastName}_${tk}_${date}_${type}`;
    if (officialMap.has(exactKey)) return; 
    
    // Fuzzy search: check +- 2 days
    let found = false;
    const d = new Date(date);
    for (let offset = -2; offset <= 2; offset++) {
      const fd = new Date(d);
      fd.setDate(fd.getDate() + offset);
      const fdStr = fd.toISOString().split('T')[0];
      const offsetKey = `${lastName}_${tk}_${fdStr}_${type}`;
      if (officialMap.has(offsetKey)) {
        found = true;
        break;
      }
    }
    
    if (found) return;

    if (novelSet.has(exactKey)) return; // Don't duplicate inside this run

    const tradeHash = generateTradeHash(rawName, tk, date, type);
    const docId = `COMPETITOR-${tradeHash}`;

    // Full-name executive match only — never bare last-name → EXEC-*.
    const filerId = resolveExecutiveFilerIdFromName(rawName) ?? `MANUAL-${lastName.toUpperCase()}`;
    const assetName = assetNameFromCompetitorPayload(rawObj, tk);
    novelTrades.push({
      id: `${docId}-${tradeHash}`,
      docId,
      filerId,
      txDate: date,
      owner: null,
      assetName,
      ticker: tk,
      assetType: 'stock', // Fallback
      txType: type === 'buy' ? 'P' : type === 'sell' ? 'S' : 'E',
      amountMin: 1001, // default
      amountMax: 15000, // default
      isOption: false,
      capGainsOver200: false,
      rawText: JSON.stringify(rawObj),
      assetTypeName: 'Stock',
      filingStatus: 'New',
      subholding: null,
      location: null,
      description: `Injected from ${provider}`,
      supplementalText: null,
      rowKey: tradeHash,
      confidence: 100,
      source: 'competitor_backfill',
      createdAt: nowStr,
      // cursor_seq is assigned by the DB trigger; persistTransactions() binds NULL.
      cursorSeq: 0,
      firstSeenAt: nowStr,
      filedDate: date, // Treat filed_date same as tx_date for these purposes
    });
    novelSet.add(exactKey);
  }

  // Before looping over competitors, create a set of seen filers to add if missing
  const filersToAdd = new Map<string, { id: string, name: string, chamber: string }>();

  function processTradeWithFiler(provider: string, rawName: string, chamber: 'house' | 'senate' | 'executive', ticker: string, date: string, typeStr: string, rawObj: any) {
    const lastName = extractLastName(rawName);
    const execId = resolveExecutiveFilerIdFromName(rawName);
    const filerId = execId ?? `MANUAL-${lastName.toUpperCase()}`;
    const resolvedChamber = execId ? 'executive' : chamber;
    filersToAdd.set(filerId, { id: filerId, name: rawName, chamber: resolvedChamber });
    processTrade(provider, rawName, resolvedChamber as 'house' | 'senate' | 'executive', ticker, date, typeStr, rawObj);
  }

  // unusual whales
  for (const t of uwTrades) {
    const name = t.name || t.reporter || t.politician_name;
    if (name) {
      processTradeWithFiler('uw', name, t.member_type || 'house', t.ticker, t.transaction_date, t.txn_type || t.type || t.transaction_type || 'buy', t);
    }
  }

  // quiver
  for (const t of qqTrades) {
    if (t.Representative) {
      processTradeWithFiler('quiver', t.Representative, t.House === 'House' ? 'house' : 'senate', t.Ticker, t.TransactionDate, t.Transaction, t);
    }
  }

  // FMP
  for (const t of fmpHouse) processTradeWithFiler('fmp', `${t.firstName} ${t.lastName}`, 'house', t.symbol, t.transactionDate, t.type, t);
  for (const t of fmpSenate) processTradeWithFiler('fmp', `${t.firstName} ${t.lastName}`, 'senate', t.symbol, t.transactionDate, t.type, t);
  
  // Trump trades
  for (const t of trumpTrades) {
    const name = t.Representative || t.politician || 'Donald Trump';
    const ticker = t.Ticker || t.ticker;
    const date = t.TransactionDate || (t.traded ? t.traded.split(' ')[0] : null);
    const typeStr = t.Transaction || t.transaction;
    if (date && ticker) {
      processTradeWithFiler('quiver_trump', name, 'executive', ticker, date, typeStr, t);
    }
  }
  
  console.log(`Found ${novelTrades.length} novel trades across all competitor datasets.`);

  console.log("Inserting required filers...");
  for (const f of filersToAdd.values()) {
    await env.DB.prepare(
      `INSERT INTO filers (bioguide_id, full_name, chamber) 
       VALUES (?, ?, ?)
       ON CONFLICT (bioguide_id) DO NOTHING`
    ).bind(f.id, f.name, f.chamber).run();
  }

  // Batch insert
  const CHUNK_SIZE = 100;
  for (let i = 0; i < novelTrades.length; i += CHUNK_SIZE) {
    const chunk = novelTrades.slice(i, i + CHUNK_SIZE);
    console.log(`Inserting chunk ${Math.floor(i / CHUNK_SIZE) + 1} of ${Math.ceil(novelTrades.length / CHUNK_SIZE)}...`);
    const insertedIds = await persistTransactions(env, chunk);
    console.log(`Inserted ${insertedIds.length} rows.`);
  }

  console.log("Backfill complete!");
}

run().catch(console.error);
