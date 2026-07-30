import { createClient } from "npm:@libsql/client";

const ADMIN_TOKEN = "***REMOVED***";
const URL = "https://congress.trade/api/admin/debug-sql";

async function runSql(query: string, params: any[] = []): Promise<any[]> {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, params })
  });
  
  if (!res.ok) {
    throw new Error(`HTTP error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data.results;
}

async function fixUnknowns() {
  console.log("=== Checking Unknown Assets ===");
  const unknownAssets = await runSql("SELECT id, ticker, asset_name FROM transactions WHERE asset_name = 'Unknown' OR asset_name = '(unknown)' OR asset_name = 'unknown' OR asset_name = '(Unknown)' OR asset_name = 'UNKNOWN'");
  console.log(`Found ${unknownAssets.length} transactions with unknown asset names.`);
  
  if (unknownAssets.length > 0) {
    const securities = await runSql("SELECT ticker, company_name FROM securities_ref");
    const secMap = new Map<string, string>();
    for (const s of securities) {
      if (s.company_name) secMap.set(s.ticker.toUpperCase(), s.company_name);
    }
    
    let assetUpdates = 0;
    for (const row of unknownAssets) {
      if (row.ticker && secMap.has(row.ticker.toUpperCase())) {
        const newName = secMap.get(row.ticker.toUpperCase());
        if (newName) {
          await runSql("UPDATE transactions SET asset_name = ? WHERE id = ?", [newName, row.id]);
          assetUpdates++;
        }
      }
    }
    console.log(`Fixed ${assetUpdates} unknown asset names using securities_ref.`);
  }

  console.log("=== Checking Unknown Politicians ===");
  // Find transactions where the filer name is unknown
  const unknownFilersQuery = `
    SELECT t.id as tx_id, t.filer_id, f.full_name, t.doc_id 
    FROM transactions t
    LEFT JOIN filers f ON t.filer_id = f.bioguide_id
    WHERE t.filer_id = 'Unknown' OR t.filer_id = 'unknown' 
       OR f.full_name = 'Unknown' OR f.full_name = 'unknown' OR f.full_name LIKE '%Manual%' OR f.full_name IS NULL
  `;
  const unknownFilers = await runSql(unknownFilersQuery);
  console.log(`Found ${unknownFilers.length} transactions with unknown/null/manual politicians.`);
  
  // Find filings that might have the correct filer_id
  if (unknownFilers.length > 0) {
    let filerUpdates = 0;
    for (const row of unknownFilers) {
      if (row.doc_id) {
        // Look up the filing
        const filingRes = await runSql("SELECT filer_id FROM filings WHERE doc_id = ?", [row.doc_id]);
        if (filingRes.length > 0 && filingRes[0].filer_id && filingRes[0].filer_id !== 'Unknown' && filingRes[0].filer_id !== row.filer_id) {
          await runSql("UPDATE transactions SET filer_id = ? WHERE id = ?", [filingRes[0].filer_id, row.tx_id]);
          filerUpdates++;
        }
      }
    }
    console.log(`Fixed ${filerUpdates} unknown politician IDs using filings table.`);
  }
}

fixUnknowns().catch(console.error);
