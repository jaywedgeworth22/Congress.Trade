import { extractParsed } from "../src/extraction/orchestrator.ts";
import { getEnv } from "../src/deno/localD1.ts";

async function main() {
  const env = await getEnv();
  const extracted = await extractParsed(env, "H-2026-20034168");
  console.log(extracted);
}
main();
