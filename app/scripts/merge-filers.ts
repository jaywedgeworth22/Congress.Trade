import { createClient } from "@libsql/client";
import { cleanFilerName } from "../src/extraction/nameNormalizer";

const dryRun = process.argv.includes("--dry-run");

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

function scoreBioguideId(id: string): number {
  let score = 0;
  if (id.startsWith("seed-")) score += 100; // Penalize 'seed-'
  if (/-[a-z]{2}\d{2}-/.test(id)) score += 50; // Penalize district (e.g. house-ca28-)
  if (/^senate-[a-z]+-[a-z]+-senator$/.test(id)) score += 20; // Penalize -senator suffix
  if (id.startsWith("EXEC-")) score -= 50; // Keep EXEC if possible for executives
  // Prefer shorter IDs slightly
  score += id.length; 
  return score;
}

function normalizeParty(party: string | null): string | null {
  if (!party) return null;
  const p = party.trim().toLowerCase();
  if (p === "r" || p === "republican") return "Republican";
  if (p === "d" || p === "democrat") return "Democrat";
  if (p === "independent") return "Independent";
  return party;
}

async function run() {
  console.log(`Starting filers merge... Dry run: ${dryRun}`);
  const rs = await client.execute("SELECT * FROM filers");
  
  const map = new Map<string, any[]>();
  for (const row of rs.rows) {
    let name = cleanFilerName(row.full_name as string);
    // Normalize further strictly for grouping purposes
    const groupingKey = name.toLowerCase().replace(/[^a-z]/g, "");
    if (!map.has(groupingKey)) {
      map.set(groupingKey, []);
    }
    map.get(groupingKey)!.push({
      ...row,
      cleanName: name,
    });
  }

  const updates: string[] = [];
  const args: any[][] = [];
  
  let mergedCount = 0;
  let updateCount = 0;

  for (const [key, group] of map.entries()) {
    // 1. Pick canonical row
    group.sort((a, b) => scoreBioguideId(a.bioguide_id) - scoreBioguideId(b.bioguide_id));
    const canonical = group[0];
    const duplicates = group.slice(1);
    
    // Check if we need to update canonical's name or party
    const newParty = normalizeParty(canonical.party);
    const hasNameChange = canonical.cleanName !== canonical.full_name;
    const hasPartyChange = newParty !== canonical.party;
    
    if (hasNameChange || hasPartyChange) {
      updateCount++;
      if (dryRun) {
        console.log(`[UPDATE CANONICAL] ${canonical.bioguide_id}: "${canonical.full_name}" -> "${canonical.cleanName}" | Party: ${canonical.party} -> ${newParty}`);
      } else {
        updates.push(`UPDATE filers SET full_name = ?, party = ? WHERE bioguide_id = ?`);
        args.push([canonical.cleanName, newParty, canonical.bioguide_id]);
      }
    }

    if (duplicates.length > 0) {
      mergedCount += duplicates.length;
      for (const dup of duplicates) {
        if (dryRun) {
          console.log(`[MERGE] ${dup.bioguide_id} -> ${canonical.bioguide_id} (${canonical.cleanName})`);
        } else {
          // Update foreign keys in transactions
          updates.push(`UPDATE transactions SET filer_id = ? WHERE filer_id = ?`);
          args.push([canonical.bioguide_id, dup.bioguide_id]);
          
          // Update foreign keys in filings
          updates.push(`UPDATE filings SET filer_id = ? WHERE filer_id = ?`);
          args.push([canonical.bioguide_id, dup.bioguide_id]);

          // Delete duplicate filer
          updates.push(`DELETE FROM filers WHERE bioguide_id = ?`);
          args.push([dup.bioguide_id]);
        }
      }
    }
  }

  if (dryRun) {
    console.log(`\nDry run completed. Would merge ${mergedCount} duplicates and apply ${updateCount} name/party standardizations.`);
    return;
  }

  console.log(`Executing ${updates.length} statements...`);
  if (updates.length === 0) {
    console.log("No updates to perform.");
    return;
  }

  try {
    const stmts = updates.map((sql, i) => ({ sql, args: args[i] }));
    const batchSize = 20; 
    let successCount = 0;
    
    for (let i = 0; i < stmts.length; i += batchSize) {
      const chunk = stmts.slice(i, i + batchSize);
      await client.batch(chunk, "write");
      successCount += chunk.length;
    }
    console.log(`Successfully executed ${successCount} statements!`);
  } catch (err) {
    console.error("Error executing batch:", err);
  }
}

run().catch(console.error);
