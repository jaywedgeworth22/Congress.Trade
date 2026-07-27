async function main() {
  const docs = JSON.parse(await Deno.readTextFile("bad_docs.json"));
  console.log(`Setting ${docs.length} docs to error status`);
  
  const CHUNK_SIZE = 100;
  for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
    const chunk = docs.slice(i, i + CHUNK_SIZE);
    const inList = chunk.map((d: string) => `'${d}'`).join(",");
    const sql = `UPDATE filings SET ingest_status = 'error' WHERE doc_id IN (${inList});`;
    
    console.log(`Executing chunk ${Math.floor(i / CHUNK_SIZE) + 1}...`);
    const p = new Deno.Command("deno", {
      args: ["run", "-A", "scripts/exec_sql.ts", sql]
    });
    const { code, stdout, stderr } = await p.output();
    if (code !== 0) {
       console.error("Failed:", new TextDecoder().decode(stderr));
    }
  }
}
main();
