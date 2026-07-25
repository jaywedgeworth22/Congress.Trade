const API_KEY = "***REMOVED***";
const res = await fetch("https://api.quiverquant.com/beta/bulk/congresstrading", {
  headers: { "Authorization": `Token ${API_KEY}`, "Accept": "application/json" }
});
console.log(res.status, res.headers.get("content-type"));
if (res.ok) {
  const data = await res.json();
  const arr = data.data || data.results || data || [];
  console.log(JSON.stringify(arr.slice(0, 3), null, 2));
} else {
  console.log(await res.text().then(t => t.substring(0, 200)));
}
