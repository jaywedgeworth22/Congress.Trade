const key = "9ea4cb42e53fb93cf25cd3a4dff3ddbe";
async function run() {
  const url = `https://financialmodelingprep.com/api/v3/historical-price-full/BYND?apikey=${key}`;
  const stableUrl = `https://financialmodelingprep.com/api/v3/historical-price-eod/dividend-adjusted?symbol=BYND&from=2020-01-01&to=2026-07-14&apikey=${key}`;
  const res = await fetch(stableUrl);
  const data = await res.json();
  console.log(JSON.stringify(data));
}
run();
