async function main() {
  const adminToken = "***REMOVED***";
  const docs = JSON.parse(Deno.readTextFileSync("./bad_docs.json")) as string[];
  console.log(`Processing ${docs.length} docs`);

  const chunkSize = 20; // process 20 at a time
  for (let i = 0; i < docs.length; i += chunkSize) {
    const chunk = docs.slice(i, i + chunkSize);
    console.log(`Processing chunk ${Math.floor(i / chunkSize) + 1} / ${Math.ceil(docs.length / chunkSize)}`);
    
    const res = await fetch("https://congress.trade/api/admin/reprocess", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${adminToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chamber: "house",
        docIds: chunk,
        dryRun: false,
        forceVision: true
      })
    });
    
    const text = await res.text();
    try {
      const result = JSON.parse(text);
      console.log(result);
    } catch(e) {
      console.error("Failed to parse response:", text.slice(0, 500));
    }
  }
}

main().catch(console.error);
