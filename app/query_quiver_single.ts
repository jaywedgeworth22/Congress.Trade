const API_KEY = "da4c56edf26967572f5725facc25b66aeb26b4aa";
const res = await fetch("https://api.quiverquant.com/beta/historical/congresstrading", {
  headers: { "Authorization": `Token ${API_KEY}` }
});
const data = await res.json();
console.log(JSON.stringify(data.slice(0, 3), null, 2));
