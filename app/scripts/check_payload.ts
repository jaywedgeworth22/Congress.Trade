import { createClient } from "npm:@libsql/client";

const db = createClient({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN")!,
});

async function run() {
  const providers = ['unusual_whales', 'quiver'];
  for (const p of providers) {
    const sample = await db.execute({
      sql: `SELECT payload FROM disclosure_provider_observations WHERE provider = ? LIMIT 1`,
      args: [p]
    });
    if (sample.rows.length > 0) {
      console.log(`${p} sample payload:`, sample.rows[0].payload);
    }
  }
}
run();
