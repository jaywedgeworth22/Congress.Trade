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

function toTitleCase(str: string): string {
  if (!str) return str;
  return str.split(' ').map(word => {
    // Keep small words lowercase if they aren't the first word (optional for company names, usually all caps like INC., CORP. are capitalized)
    if (word.toUpperCase() === word) {
      // If it's already an acronym like "IBM", keep it. But if it's "APPLE INC.", we want "Apple Inc."
      // Actually, standard title case:
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

async function fixCompanyNames() {
  console.log("Fetching all securities...");
  const securities = await runSql("SELECT ticker, company_name FROM securities_ref WHERE company_name IS NOT NULL");
  console.log(`Found ${securities.length} securities`);
  
  let updated = 0;
  for (const s of securities) {
    const original = s.company_name as string;
    const proper = toTitleCase(original);
    
    // Adjust common suffixes
    const finalProper = proper
      .replace(/\bInc\b/gi, "Inc.")
      .replace(/\bCorp\b/gi, "Corp.")
      .replace(/\bLlc\b/gi, "LLC")
      .replace(/\bLtd\b/gi, "Ltd.")
      .replace(/\bPlc\b/gi, "PLC")
      .replace(/\s\.\s/g, "."); // cleanup any stray dots if they were split
      
    // Let's remove double dots
    const cleanFinal = finalProper.replace(/\.\./g, ".");
    
    if (original !== cleanFinal) {
      console.log(`${original} -> ${cleanFinal}`);
      await runSql("UPDATE securities_ref SET company_name = ? WHERE ticker = ?", [cleanFinal, s.ticker]);
      updated++;
    }
  }
  console.log(`Updated ${updated} company names`);
}

fixCompanyNames().catch(console.error);
