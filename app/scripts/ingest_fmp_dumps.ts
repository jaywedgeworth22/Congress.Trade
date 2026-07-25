const senateData = JSON.parse(await Deno.readTextFile("/Users/jay/Code/Congress.Trade/data/hoarded/fmp_senate.json"));
const houseData = JSON.parse(await Deno.readTextFile("/Users/jay/Code/Congress.Trade/data/hoarded/fmp_house.json"));

const CHUNK_SIZE = 500;
async function push(chamber: string, data: any[]) {
  console.log(`Pushing ${data.length} records for ${chamber}...`);
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.slice(i, i + CHUNK_SIZE);
    const res = await fetch("https://congress.trade/api/admin/backfill-fmp-dumps", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("ADMIN_TOKEN")}`,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
      },
      body: JSON.stringify({ chamber, data: chunk })
    });
    if (!res.ok) {
      console.error(`Failed at index ${i}: ${await res.text()}`);
      Deno.exit(1);
    }
    console.log(`Pushed ${i + chunk.length}/${data.length} (${Math.round((i + chunk.length)/data.length * 100)}%)`);
  }
}

await push('senate', senateData);
await push('house', houseData);
console.log("Done.");
