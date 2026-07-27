const ADMIN_TOKEN = "56c11f2e0c7fa4d019d379fd0b8676199ad1186ad8b09fe5be6a7b2ecbf05060";
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

function toTitleCase(str: string): string {
  if (!str) return str;
  return str.split(' ').map(word => {
    // preserve "(unknown)"
    if (word === '(unknown)') return '(Unknown)';
    
    // If it's already mixed case or all caps (like ETF, PLC, LLC), leave it alone.
    // Wait, the issue is these are ALL LOWERCASE.
    // So word.toUpperCase() !== word (they have letters) and word.toLowerCase() === word
    if (word.length > 0) {
       return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    return word;
  }).join(' ');
}

async function fixAssetNames() {
  console.log("Fetching transactions with lowercase alphabetical asset_names...");
  const txs = await runSql("SELECT id, ticker, asset_name FROM transactions WHERE asset_name = LOWER(asset_name) AND asset_name != UPPER(asset_name)");
  console.log(`Found ${txs.length} transactions`);
  
  const securitiesMap = new Map<string, string>();
  const securities = await runSql("SELECT ticker, company_name FROM securities_ref");
  for (const s of securities) {
    securitiesMap.set(s.ticker, s.company_name);
  }

  let updatedCount = 0;
  for (const tx of txs) {
    let newName = "";
    
    // 1. If it's just a lowercased ticker, grab the real company name
    if (tx.ticker && securitiesMap.has(tx.ticker) && tx.asset_name === tx.ticker.toLowerCase()) {
      newName = securitiesMap.get(tx.ticker)!;
    } 
    else if (!tx.ticker && tx.asset_name && tx.asset_name.length <= 5 && securitiesMap.has(tx.asset_name.toUpperCase())) {
      // It's a ticker but ticker field is null!
      newName = securitiesMap.get(tx.asset_name.toUpperCase())!;
      // Also update the ticker field while we're at it!
      await runSql("UPDATE transactions SET ticker = ?, asset_name = ? WHERE id = ?", [tx.asset_name.toUpperCase(), newName, tx.id]);
      updatedCount++;
      continue;
    } 
    else {
      // 2. Otherwise, title case it
      newName = toTitleCase(tx.asset_name as string);
    }
    
    if (newName && newName !== tx.asset_name) {
      await runSql("UPDATE transactions SET asset_name = ? WHERE id = ?", [newName, tx.id]);
      updatedCount++;
      if (updatedCount % 100 === 0) console.log(`Updated ${updatedCount}...`);
    }
  }
  
  console.log(`Successfully updated ${updatedCount} asset names in transactions.`);
}

fixAssetNames().catch(console.error);
