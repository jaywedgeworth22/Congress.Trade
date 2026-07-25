import { createClient } from "@libsql/client";
import { resolveSecret, resolveSecrets } from "../src/secrets/infisical.ts";

const CONCURRENCY = 5;

class Semaphore {
  private count = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
  }
  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.count--;
    }
  }
}

async function main() {
  console.log("Fetching secrets from Infisical...");
  
  const tursoUrlRes = await resolveSecret(Deno.env.toObject() as any, "TURSO_DATABASE_URL");
  const tursoTokenRes = await resolveSecret(Deno.env.toObject() as any, "TURSO_AUTH_TOKEN");
  const dbUrl = tursoUrlRes.value || Deno.env.get("TURSO_DATABASE_URL");
  const dbToken = tursoTokenRes.value || Deno.env.get("TURSO_AUTH_TOKEN");

  if (!dbUrl || !dbToken) {
    throw new Error("Missing Turso secrets");
  }
  
  const db = createClient({ url: dbUrl, authToken: dbToken });

  console.log("Querying filings with source_url...");
  const rs = await db.execute("SELECT doc_id, chamber, substr(filed_date, 1, 4) as year, source_url FROM filings WHERE source_url IS NOT NULL");
  
  const filings = rs.rows.map(r => ({
    docId: r.doc_id as string,
    chamber: (r.chamber as string).toLowerCase(),
    year: r.year as string,
    sourceUrl: r.source_url as string,
  }));

  console.log(`Found ${filings.length} filings with source_url. Starting download to scratch directory...`);
  
  const sem = new Semaphore(CONCURRENCY);
  let success = 0;
  let failed = 0;
  let skipped = 0;

  const baseDir = "/Users/jay/.gemini/antigravity/brain/de3d0d13-c3a4-425c-9fbe-a4b16407c93a/scratch/raw-pdfs";
  
  // ensure dirs exist
  await Deno.mkdir(baseDir, { recursive: true });

  const tasks = filings.map(async (f, i) => {
    await sem.acquire();
    try {
      if (!f.sourceUrl) { skipped++; return; }
      
      const dirPath = `${baseDir}/${f.chamber}/${f.year}`;
      await Deno.mkdir(dirPath, { recursive: true });
      
      const filePath = `${dirPath}/${f.docId}.pdf`;
      
      // Check if file already exists
      try {
        const stat = await Deno.stat(filePath);
        if (stat.isFile && stat.size > 0) {
            skipped++;
            if (skipped % 100 === 0) console.log(`[${i}/${filings.length}] Skipped ${skipped} items (already downloaded)`);
            return;
        }
      } catch (e: any) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }

      const res = await fetch(f.sourceUrl, {
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36" }
      });
      if (!res.ok) {
        if (res.status === 404 || res.status === 403) {
            console.error(`Skipping ${f.docId} (${f.sourceUrl}): HTTP ${res.status}`);
            failed++;
            return;
        }
        throw new Error(`Failed to download ${f.sourceUrl}: HTTP ${res.status}`);
      }
      
      const arrayBuffer = await res.arrayBuffer();
      await Deno.writeFile(filePath, new Uint8Array(arrayBuffer));
      
      success++;
      if (success % 20 === 0) console.log(`[${i}/${filings.length}] Downloaded ${success} PDFs to disk (${arrayBuffer.byteLength} bytes)`);
    } catch (e) {
      console.error(`Error processing ${f.docId} (${f.sourceUrl}):`, (e as any).message);
      failed++;
    } finally {
      setTimeout(() => sem.release(), 100);
    }
  });

  await Promise.all(tasks);
  console.log(`\nDone! Success: ${success}, Skipped: ${skipped}, Failed: ${failed}`);
}

main().catch(console.error);
