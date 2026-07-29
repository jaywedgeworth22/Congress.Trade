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
  const data = await res.json();
  return data.results;
}

async function fixCompanyNames() {
  const securities = await runSql("SELECT ticker, company_name FROM securities_ref WHERE company_name IS NOT NULL");
  let updated = 0;
  for (const s of securities) {
    const original = s.company_name as string;
    
    const cleanFinal = original
      .replace(/\bN\.v\./g, "N.V.")
      .replace(/\bS\.a\.b\.\b/g, "S.A.B.")
      .replace(/\bDe C\.v\./g, "de C.V.")
      .replace(/\bS\.p\.a\./g, "S.p.A.")
      .replace(/\bS\.a\./g, "S.A.")
      .replace(/\bA\/s\b/g, "A/S")
      .replace(/\bPldt\b/g, "PLDT")
      .replace(/\bWd-40\b/g, "WD-40")
      .replace(/\bEtns\b/g, "ETNs")
      .replace(/\bMsci\b/g, "MSCI")
      .replace(/\bSpdr\b/g, "SPDR")
      .replace(/\bFtse\b/g, "FTSE");
    
    if (original !== cleanFinal) {
      await runSql("UPDATE securities_ref SET company_name = ? WHERE ticker = ?", [cleanFinal, s.ticker]);
      updated++;
    }
  }
  console.log(`Updated ${updated} company names`);
}
fixCompanyNames();
