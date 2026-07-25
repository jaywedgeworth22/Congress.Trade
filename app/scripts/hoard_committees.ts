import * as path from "node:path";
import * as fs from "node:fs/promises";

const BASE_URL = "https://raw.githubusercontent.com/unitedstates/congress-legislators/main";
const SCRATCH_DIR = "/Users/jay/.gemini/antigravity/brain/46787371-bd2d-4703-a05d-cf01380534f5/scratch";

async function downloadFile(filename: string) {
  console.log(`Downloading ${filename}...`);
  const url = `${BASE_URL}/${filename}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch ${url}: ${res.status}`);
    return;
  }
  const data = await res.text();
  const outPath = path.join(SCRATCH_DIR, filename);
  await fs.writeFile(outPath, data);
  console.log(`Saved ${filename}`);
}

async function main() {
  await downloadFile("committees-current.yaml");
  await downloadFile("committee-membership-current.yaml");
  await downloadFile("committees-historical.yaml");
  // There is no committee-membership-historical.yaml in the root, it might not exist. We'll try anyway or just skip it if it 404s.
  await downloadFile("legislators-current.yaml");
  await downloadFile("legislators-historical.yaml");
  await downloadFile("executive.yaml");
}

main().catch(console.error);
