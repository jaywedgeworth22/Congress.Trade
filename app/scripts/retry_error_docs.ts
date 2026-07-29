async function main() {
  const adminToken = "***REMOVED***";
  
  const res = await fetch("https://congress.trade/api/admin/ingest-retry-errored", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${adminToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      limit: 2000,
      dryRun: false
    })
  });
  
  const text = await res.text();
  console.log(text);
}
main();
