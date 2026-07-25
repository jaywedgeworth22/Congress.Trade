const res = await fetch("https://congress.trade/api/transactions?limit=2");
const json = await res.json();
console.log(json.transactions.map((t: any) => t.cursorSeq));
