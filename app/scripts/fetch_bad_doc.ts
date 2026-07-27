async function main() {
  const adminToken = "***REMOVED***";
  const docs = JSON.parse(Deno.readTextFileSync("./bad_docs.json")) as string[];
  const doc_id = docs[0];

  const res = await fetch(`https://congress.trade/api/client/v1/filings/${doc_id}`);
  console.log(await res.json());
}
main();
