import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { createClient } from "npm:@libsql/client";

async function main() {
  const env = await load({ envPath: "/Users/jay/Code/Congress.Trade/app/.prod.vars" });
  const client = createClient({
    url: env.TURSO_DATABASE_URL || env.TURSO_URL || "", 
    authToken: env.TURSO_AUTH_TOKEN || ""
  });

  const filers = [
    { id: 'EXEC-DJT', name: 'Donald Trump', chamber: 'executive' },
    { id: 'EXEC-CWRIGHT', name: 'Chris Wright', chamber: 'executive' },
    { id: 'EXEC-MCCORMICK', name: 'David McCormick', chamber: 'executive' },
    { id: 'EXEC-MCMAHON', name: 'Linda McMahon', chamber: 'executive' },
    { id: 'EXEC-BESSENT', name: 'Scott Bessent', chamber: 'executive' },
    { id: 'MANUAL-MCCAUL', name: 'Michael McCaul', chamber: 'house' },
    { id: 'MANUAL-TAYLOR', name: 'Nicholas Taylor', chamber: 'house' },
    { id: 'MANUAL-ALLEN', name: 'Richard Allen', chamber: 'house' },
  ];

  for (const f of filers) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO filers (bioguide_id, full_name, chamber) VALUES (?, ?, ?)`,
      args: [f.id, f.name, f.chamber]
    });
    console.log(`Inserted ${f.id}`);
  }

  console.log("Done");
}

main().catch(console.error);
