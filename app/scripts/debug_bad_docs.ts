import { createClient } from "npm:@libsql/client";
import "npm:dotenv/config";
import { readFileSync } from "node:fs";

async function run() {
  const adminToken = "***REMOVED***";
  const res = await fetch("https://congress.trade/api/health");
  console.log(await res.json());

  // Wait, I don't have the turso credentials.
  // I will just use the `/debug-extract/:id` endpoint which I deployed!
  const docs = JSON.parse(readFileSync("./bad_docs.json", "utf8")) as string[];
  const id = docs[0];
  const extr = await fetch(`https://congress.trade/api/admin/debug-extract/${id}`, {
    headers: { "Authorization": `Bearer ${adminToken}` }
  });
  console.log("DEBUG EXTRACT", id, await extr.text());
}
run();
