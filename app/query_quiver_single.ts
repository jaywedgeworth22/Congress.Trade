const API_KEY = "***REMOVED***";
const res = await fetch("https://api.quiverquant.com/beta/historical/congresstrading", {
  headers: { "Authorization": `Token ${API_KEY}` }
});
const data = await res.json();
console.log(JSON.stringify(data.slice(0, 3), null, 2));
