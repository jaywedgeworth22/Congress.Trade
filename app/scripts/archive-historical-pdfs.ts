import { createClient } from "@libsql/client";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { resolveSecret, resolveSecrets } from "../src/secrets/infisical.ts";

const CONCURRENCY = 2; // Reduced to 2 to avoid aggressive rate limits

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

  const s3EpRes = await resolveSecret(Deno.env.toObject() as any, "CF_R2_S3_ENDPOINT");
  const s3IdRes = await resolveSecret(Deno.env.toObject() as any, "CF_R2_S3_ACCESS_KEY_ID");
  const s3SecRes = await resolveSecret(Deno.env.toObject() as any, "CF_R2_S3_SECRET_ACCESS_KEY");
  
  const s3Ep = s3EpRes.value || Deno.env.get("CF_R2_S3_ENDPOINT");
  const s3Id = s3IdRes.value || Deno.env.get("CF_R2_S3_ACCESS_KEY_ID");
  const s3Sec = s3SecRes.value || Deno.env.get("CF_R2_S3_SECRET_ACCESS_KEY");
  
  if (!dbUrl || !dbToken || !s3Ep || !s3Id || !s3Sec) {
    throw new Error("Missing Turso or R2 S3 secrets");
  }
  
  const db = createClient({ url: dbUrl, authToken: dbToken });

  const s3 = new S3Client({
    region: "auto",
    endpoint: s3Ep,
    forcePathStyle: true,
    credentials: { accessKeyId: s3Id, secretAccessKey: s3Sec },
  });

  const bucket = "congress-trade-bucket";

  console.log("Querying filings with source_url...");
  const rs = await db.execute("SELECT doc_id, chamber, substr(filed_date, 1, 4) as year, source_url FROM filings WHERE source_url IS NOT NULL");
  
  const filings = rs.rows.map(r => ({
    docId: r.doc_id as string,
    chamber: (r.chamber as string).toLowerCase(),
    year: r.year as string,
    sourceUrl: r.source_url as string,
  }));

  console.log(`Found ${filings.length} filings with source_url. Starting download and backup to R2...`);
  
  const sem = new Semaphore(CONCURRENCY);
  let success = 0;
  let failed = 0;
  let skipped = 0;

  const tasks = filings.map(async (f, i) => {
    await sem.acquire();
    try {
      if (!f.sourceUrl) { skipped++; return; }
      const s3Key = `raw-pdfs/${f.chamber}/${f.year}/${f.docId}.pdf`;
      
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
      
      // Basic sanity check for PDF
      const prefix = new TextDecoder().decode(new Uint8Array(arrayBuffer.slice(0, 5)));
      if (prefix !== "%PDF-") {
         console.warn(`[WARNING] File downloaded for ${f.docId} does not start with %PDF-`);
      }

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: new Uint8Array(arrayBuffer),
        ContentType: "application/pdf"
      }));
      success++;
      if (success % 20 === 0) console.log(`[${i}/${filings.length}] Backed up ${success} PDFs to R2 (${arrayBuffer.byteLength} bytes)`);
    } catch (e) {
      console.error(`Error processing ${f.docId} (${f.sourceUrl}):`, (e as any).message);
      failed++;
    } finally {
      // Avoid hammering the server too quickly
      setTimeout(() => sem.release(), 500);
    }
  });

  await Promise.all(tasks);
  console.log(`\nDone! Success: ${success}, Skipped: ${skipped}, Failed: ${failed}`);
}

main().catch(console.error);
