import { createClient } from "npm:@libsql/client/web";
import { resolveSecret, refreshSecrets } from "./app/src/secrets/infisical.ts";

async function main() {
  const env: any = { CONFIG_KV: await Deno.openKv() };
  for (const k of Object.keys(Deno.env.toObject())) env[k] = Deno.env.get(k);
  await refreshSecrets(env);
  const tursoUrlRes = await resolveSecret(env, 'TURSO_DATABASE_URL');
  const tursoTokenRes = await resolveSecret(env, 'TURSO_AUTH_TOKEN');
  const client = createClient({
    url: tursoUrlRes.value || '',
    authToken: tursoTokenRes.value || '',
  });
  try {
    const res = await client.execute("SELECT * FROM d1_budget LIMIT 1");
    console.log("Success:", res.rows);
  } catch (e) {
    console.error("Error:", e);
  }
}
main();
