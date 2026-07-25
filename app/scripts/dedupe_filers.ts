import { createClient } from "@libsql/client";

const dryRun = process.argv.includes("--dry-run");

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

function normalizeParty(party: string | null): string | null {
  if (!party) return null;
  const p = party.trim().toLowerCase();
  if (p === "r" || p === "republican") return "Republican";
  if (p === "d" || p === "democrat") return "Democrat";
  if (p === "independent") return "Independent";
  return party;
}

// These are the groups identified in filers_analysis.md
const duplicateGroups = [

  ["senate-a-mitchell-jr-mcconnell", "senate-mcconnell-a-mitchell-jr-senator"],
  ["senate-bernardo-moreno", "senate-moreno-bernardo-senator"],
  ["senate-david-h-mccormick", "senate-mccormick-david-h-senator"],
  ["senate-john-r-curtis", "senate-curtis-john-r-senator"],
  ["house-fl02-neal-patrick-dunn", "house-fl02-neal-patrick-md-facs-dunn"],

  ["senate-adam-b-schiff", "house-ca28-adam-b-schiff"],
  ["house-wv03-carol-devine-miller", "house-wv01-carol-devine-miller"],
  ["house-nc09-dan-daniel-bishop", "house-nc08-dan-daniel-bishop"],
  ["house-mi06-debbie-dingell", "house-mi12-debbie-dingell"],
  ["house-fl25-debbie-wasserman-schultz", "house-fl23-debbie-wasserman-schultz"],
  ["senate-dianne-feinstein", "seed-senate-dianne-feinstein"],
  ["house-ca07-doris-o-matsui", "house-ca06-doris-o-matsui"],
  ["house-ca31-gilbert-cisneros", "house-ca39-gilbert-cisneros"],
  ["senate-jerry-moran", "seed-senate-jerry-moran"],
  ["senate-john-boozman", "seed-senate-john-boozman"],
  ["senate-john-curtis", "house-ut03-john-curtis"],
  ["senate-john-hoeven", "seed-senate-john-hoeven"],
  ["house-fl04-john-rutherford", "house-fl05-john-rutherford"],
  ["house-ca27-judy-chu", "house-ca28-judy-chu"],
  ["senate-kelly-loeffler", "seed-senate-kelly-loeffler"],
  ["house-tx37-lloyd-doggett", "house-tx35-lloyd-doggett"],
  ["house-fl22-lois-frankel", "house-fl21-lois-frankel"],
  ["senate-maria-cantwell", "seed-senate-maria-cantwell"],
  ["house-ca25-michael-garcia", "house-ca27-michael-garcia"],
  ["house-pa16-mike-kelly", "house-pa03-mike-kelly"],
  ["house-ca11-nancy-pelosi", "house-ca12-nancy-pelosi"],
  ["senate-pat-roberts", "seed-senate-pat-roberts"],
  ["house-tx17-pete-sessions", "house-tx32-pete-sessions"],
  ["senate-richard-blumenthal", "seed-senate-richard-blumenthal"],
  ["senate-rick-scott", "seed-senate-rick-scott"],
  ["senate-roger-w-marshall", "house-ks01-roger-w-marshall"],
  ["senate-ron-wyden", "seed-senate-ron-wyden"],
  ["senate-roy-blunt", "seed-senate-roy-blunt"],
  ["house-ca51-sara-jacobs", "house-ca53-sara-jacobs"],
  ["house-fl15-scott-franklin", "house-fl18-scott-franklin"],
  ["house-ca50-scott-h-peters", "house-ca52-scott-h-peters"],
  ["senate-sheldon-whitehouse", "seed-senate-sheldon-whitehouse"],
  ["senate-susan-m-collins", "seed-senate-susan-m-collins"],
  ["senate-tammy-duckworth", "house-il08-tammy-duckworth", "seed-senate-tammy-duckworth"],
  ["senate-thomas-r-carper", "seed-senate-thomas-r-carper"],
  ["senate-tina-smith", "seed-senate-tina-smith"],
  ["house-ca18-zoe-lofgren", "house-ca19-zoe-lofgren"],
];

async function run() {
  console.log(`Starting exact filer merge... Dry run: ${dryRun}`);
  
  const updates: string[] = [];
  const args: any[][] = [];
  
  // Also standardize ALL party names across the table
  const allFilers = await client.execute("SELECT * FROM filers");
  let partyUpdates = 0;
  for (const f of allFilers.rows) {
    const p = normalizeParty(f.party as string | null);
    if (p && p !== f.party) {
      partyUpdates++;
      if (dryRun) {
        console.log(`[PARTY_NORM] ${f.bioguide_id} party: ${f.party} -> ${p}`);
      } else {
        updates.push("UPDATE filers SET party = ? WHERE bioguide_id = ?");
        args.push([p, f.bioguide_id]);
      }
    }
  }


  // Automatically discover manual filers that exactly match a canonical filer's full_name
  const manualMatches = await client.execute(`
    SELECT m.bioguide_id as manual_id, c.bioguide_id as canonical_id, c.full_name
    FROM filers m
    JOIN filers c ON m.full_name = c.full_name 
      AND c.bioguide_id NOT LIKE 'MANUAL-%' 
      AND c.bioguide_id != m.bioguide_id
    WHERE m.bioguide_id LIKE 'MANUAL-%'
  `);
  
  for (const row of manualMatches.rows) {
    const canonical = row.canonical_id as string;
    const manual = row.manual_id as string;
    
    // Check if we already have this in duplicateGroups, if not, add it
    let found = false;
    for (const group of duplicateGroups) {
      if (group[0] === canonical && group.includes(manual)) {
        found = true;
        break;
      }
    }
    if (!found) {
      duplicateGroups.push([canonical, manual]);
    }
  }

  for (const group of duplicateGroups) {
    const canonical = group[0]; // First in the array is the canonical one we keep
    const duplicates = group.slice(1);
    
    for (const dup of duplicates) {
      if (dryRun) {
        console.log(`[MERGE] ${dup} -> ${canonical}`);
      } else {
        updates.push(`UPDATE transactions SET filer_id = ? WHERE filer_id = ?`);
        args.push([canonical, dup]);
        
        updates.push(`UPDATE filings SET filer_id = ? WHERE filer_id = ?`);
        args.push([canonical, dup]);

        updates.push(`DELETE FROM filers WHERE bioguide_id = ?`);
        args.push([dup]);
      }
    }
  }

  if (dryRun) {
    console.log(`\nDry run completed. Would run ${partyUpdates} party normalizations and ${duplicateGroups.length} merges.`);
    return;
  }

  console.log(`Executing ${updates.length} statements...`);
  if (updates.length === 0) {
    console.log("No updates to perform.");
    return;
  }

  const stmts = updates.map((sql, i) => ({ sql, args: args[i] }));
  const batchSize = 20; 
  let successCount = 0;
  
  for (let i = 0; i < stmts.length; i += batchSize) {
    const chunk = stmts.slice(i, i + batchSize);
    await client.batch(chunk, "write");
    successCount += chunk.length;
  }
  console.log(`Successfully executed ${successCount} statements!`);
}

run().catch(console.error);
