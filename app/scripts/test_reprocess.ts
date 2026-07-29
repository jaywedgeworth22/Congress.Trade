async function main() {
  const adminToken = "***REMOVED***";
  const docs = JSON.parse(Deno.readTextFileSync("./bad_docs.json")) as string[];
  const chunk = docs.slice(0, 1);
    
  const res = await fetch("https://congress.trade/api/admin/agreement-reprocess", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${adminToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      docIds: chunk,
      n: 1,
      models: [
        { "provider": "openrouter", "model": "google/gemini-3.5-flash" },
        { "provider": "openrouter", "model": "openai/gpt-5.6-luna" }
      ],
      dryRun: false
    })
  });
  
  const text = await res.text();
  console.log(text);
}
main();
