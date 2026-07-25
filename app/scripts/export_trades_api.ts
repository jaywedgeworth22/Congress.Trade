const baseUrl = "https://congress.trade/api/client/v1";

async function main() {
  console.log("Fetching trades via production API...");
  let allTrades = [];
  let cursor = null;
  
  while (true) {
    const url = new URL(`${baseUrl}/feed`);
    if (cursor) url.searchParams.set("cursor", cursor);
    url.searchParams.set("limit", "100");
    
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.error(`Failed to fetch: ${res.status} ${res.statusText}`);
      const text = await res.text();
      console.error(text);
      break;
    }
    const data = await res.json();
    if (data.items) {
      allTrades.push(...data.items);
      console.log(`Fetched ${allTrades.length} trades...`);
    }
    
    if (data.nextCursor) {
      cursor = data.nextCursor;
    } else {
      break;
    }
  }

  console.log(`Total fetched: ${allTrades.length}`);
  
  let csv = "id,doc_id,chamber,tx_date,type,ticker,member\n";
  for (const t of allTrades) {
    csv += `${t.id},${t.docId || ''},${t.chamber},${t.txDate},${t.txType},${t.ticker},"${t.filer?.name || t.filer}"\n`;
  }
  
  await Deno.writeTextFile("../data/hoarded/our_trades.csv", csv);
  console.log("Wrote our_trades.csv");
}

main().catch(console.error);
