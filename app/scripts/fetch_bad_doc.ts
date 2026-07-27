async function main() {
  const adminToken = "56c11f2e0c7fa4d019d379fd0b8676199ad1186ad8b09fe5be6a7b2ecbf05060";
  const docs = JSON.parse(Deno.readTextFileSync("./bad_docs.json")) as string[];
  const doc_id = docs[0];

  const res = await fetch(`https://congress.trade/api/client/v1/filings/${doc_id}`);
  console.log(await res.json());
}
main();
