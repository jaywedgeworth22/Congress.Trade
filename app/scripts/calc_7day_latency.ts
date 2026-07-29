import { createClient } from "npm:@libsql/client";

async function run() {
  const dbUrl = Deno.env.get("TURSO_DATABASE_URL") || "";
  const dbToken = Deno.env.get("TURSO_AUTH_TOKEN") || "";

  const client = createClient({ url: dbUrl, authToken: dbToken });

  // Query trade_provider_observations matched against our primary filings table by trade_hash
  const res = await client.execute({
    sql: `
      SELECT 
        o.provider,
        o.filer_name,
        o.trade_hash,
        o.filed_date,
        o.first_observed_at as competitor_seen_at,
        fi.doc_id,
        fi.first_seen_at as ct_first_seen_at
      FROM trade_provider_observations o
      LEFT JOIN filings fi ON (
        fi.doc_id LIKE '%' || o.provider_key || '%'
        OR (fi.first_seen_at IS NOT NULL AND ABS(strftime('%s', fi.first_seen_at) - strftime('%s', o.first_observed_at)) < 86400)
      )
      WHERE o.first_observed_at >= datetime('now', '-7 days')
      ORDER BY o.first_observed_at DESC
    `,
    args: []
  });

  console.log(`\n=============================================================`);
  console.log(`=== 7-DAY LATENCY COMPARISON: CONGRESS.TRADE vs COMPETITORS ===`);
  console.log(`=============================================================\n`);
  console.log(`Total Competitor Disclosures Ingested/Observed (Past 7 Days): ${res.rows.length}`);

  const byProvider: Record<string, { total: number; ctWon: number; competitorWon: number; totalLagHours: number; leads: any[] }> = {};

  for (const r of res.rows as any[]) {
    const prov = r.provider as string;
    if (!byProvider[prov]) {
      byProvider[prov] = { total: 0, ctWon: 0, competitorWon: 0, totalLagHours: 0, leads: [] };
    }
    const s = byProvider[prov];
    s.total++;

    if (r.ct_first_seen_at && r.competitor_seen_at) {
      const ctTime = new Date(r.ct_first_seen_at).getTime();
      const compTime = new Date(r.competitor_seen_at).getTime();
      const diffHours = (ctTime - compTime) / (1000 * 60 * 60);

      if (diffHours > 0.1) { // Competitor faster by >6 mins
        s.competitorWon++;
        s.totalLagHours += diffHours;
        if (s.leads.length < 5) {
          s.leads.push({
            filer: r.filer_name,
            hash: r.trade_hash,
            compSeen: r.competitor_seen_at,
            ctSeen: r.ct_first_seen_at,
            leadHours: diffHours.toFixed(1)
          });
        }
      } else {
        s.ctWon++;
      }
    }
  }

  for (const [prov, s] of Object.entries(byProvider)) {
    const avgLead = s.competitorWon > 0 ? (s.totalLagHours / s.competitorWon).toFixed(1) : "0.0";
    console.log(`📌 PROVIDER: [${prov.toUpperCase()}]`);
    console.log(`   - Disclosures Observed (Past 7 Days): ${s.total}`);
    console.log(`   - Competitor Led By Average:           ${avgLead} hours (${(Number(avgLead) * 60).toFixed(0)} minutes)`);
    if (s.leads.length > 0) {
      console.log(`   - Recent Examples Where Competitor Was Faster:`);
      for (const l of s.leads) {
        console.log(`     • ${l.filer} (${l.hash}): Competitor +${l.leadHours} hrs ahead [Comp: ${l.compSeen} | CT: ${l.ctSeen}]`);
      }
    }
    console.log(``);
  }
}

run().catch(console.error);
