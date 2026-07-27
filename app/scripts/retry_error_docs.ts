async function main() {
  const adminToken = "56c11f2e0c7fa4d019d379fd0b8676199ad1186ad8b09fe5be6a7b2ecbf05060";
  
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
