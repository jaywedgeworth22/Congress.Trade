import { getEnv } from "../src/deno/localD1.ts";
async function main() {
  const env = await getEnv();
  const res = await env.DB.prepare("SELECT doc_kind FROM filings WHERE doc_id = 'H-2026-20034168'").first();
  console.log(res);
}
main();
