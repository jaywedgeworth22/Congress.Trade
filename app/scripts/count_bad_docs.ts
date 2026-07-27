async function main() {
  const docs = JSON.parse(await Deno.readTextFile("bad_docs.json"));
  console.log("Total docs in json:", docs.length);
  const uniqueDocs = [...new Set(docs)];
  console.log("Unique docs in json:", uniqueDocs.length);
}
main();
