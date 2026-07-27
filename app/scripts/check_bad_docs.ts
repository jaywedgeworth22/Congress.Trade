async function main() {
  const docs = JSON.parse(await Deno.readTextFile("bad_docs.json"));
  
  const CHUNK_SIZE = 100;
  let totalFound = 0;
  for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
    const chunk = docs.slice(i, i + CHUNK_SIZE);
    const inList = chunk.map((d: string) => `'${d}'`).join(",");
    const sql = `SELECT count(*) FROM filings WHERE doc_id IN (${inList});`;
    
    const p = new Deno.Command("deno", {
      args: ["run", "-A", "scripts/exec_sql.ts", sql]
    });
    const { code, stdout, stderr } = await p.output();
    if (code === 0) {
       const out = JSON.parse(new TextDecoder().decode(stdout).split('\n').slice(1).join('\n'));
       totalFound += out.results[0]["count(*)"];
    }
  }
  console.log("Total found in DB:", totalFound);
}
main();
