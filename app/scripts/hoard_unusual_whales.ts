import * as path from "node:path";
import * as fs from "node:fs/promises";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { resolveSecret } from "../src/secrets/infisical.ts";

const API_KEY = "***REMOVED***";
const BASE_URL = "https://api.unusualwhales.com/api";
const SCRATCH_DIR = "/Users/jay/.gemini/antigravity/brain/46787371-bd2d-4703-a05d-cf01380534f5/scratch";
const BUCKET = "congress-trade-bucket";

async function getS3() {
  const s3EpRes = await resolveSecret(Deno.env.toObject() as any, "CF_R2_S3_ENDPOINT");
  const s3IdRes = await resolveSecret(Deno.env.toObject() as any, "CF_R2_S3_ACCESS_KEY_ID");
  const s3SecRes = await resolveSecret(Deno.env.toObject() as any, "CF_R2_S3_SECRET_ACCESS_KEY");
  
  const s3Ep = s3EpRes.value || Deno.env.get("CF_R2_S3_ENDPOINT");
  const s3Id = s3IdRes.value || Deno.env.get("CF_R2_S3_ACCESS_KEY_ID");
  const s3Sec = s3SecRes.value || Deno.env.get("CF_R2_S3_SECRET_ACCESS_KEY");
  
  if (!s3Ep || !s3Id || !s3Sec) throw new Error("Missing R2 credentials");
  return new S3Client({
    region: "auto",
    endpoint: s3Ep,
    forcePathStyle: true,
    credentials: { accessKeyId: s3Id, secretAccessKey: s3Sec },
  });
}

async function fetchPage(endpoint: string, page: number = 1, limit: number = 100): Promise<any> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));
  
  const res = await fetch(url.toString(), {
    headers: { "Authorization": `Bearer ${API_KEY}` }
  });
  
  if (!res.ok) {
    if (res.status === 404) return [];
    if (res.status === 429) return null; // Throttle
    throw new Error(`Failed to fetch ${url}: ${res.status} ${await res.text()}`);
  }
  
  return res.json();
}

function generateProviderKey(item: any): string {
    return (item.name || item.id) + "-" + item.ticker + "-" + item.transaction_date + "-" + item.txn_type;
}

async function uploadToR2(s3: S3Client, filename: string, data: any) {
  const key = `competitors/unusualwhales/${new Date().toISOString().split('T')[0]}/${filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(data),
    ContentType: "application/json"
  }));
  console.log(`Uploaded ${filename} to R2: ${key}`);
}

async function postObservations(adminToken: string, data: any[]) {
    const observations = data.map(item => ({
        provider: "unusualwhales",
        chamber: item.member_type ? item.member_type.toLowerCase() : "unknown",
        trade_hash: generateProviderKey(item),
        first_observed_at: new Date().toISOString(),
        last_observed_at: new Date().toISOString(),
        source_url: null,
        filed_date: item.filed_at_date || null,
        filer_name: item.name || null,
        payload: item
    }));

    const batchSize = 500;
    for (let i = 0; i < observations.length; i += batchSize) {
        const batch = observations.slice(i, i + batchSize);
        const res = await fetch("https://congress.trade/api/admin/backfill-observations", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`,
                "user-agent": "Congress.Trade Data Hoarder"
            },
            body: JSON.stringify(batch)
        });
        if (!res.ok) {
            console.error(`Failed to post batch ${i}: HTTP ${res.status}`);
        } else {
            console.log(`Posted batch ${i} to backfill-observations.`);
        }
    }
}

async function hoardPaginated(endpoint: string, filename: string, s3: S3Client, adminToken: string) {
  console.log(`Hoarding ${endpoint}...`);
  const allData: any[] = [];
  let page = 1;
  const limit = 100;
  
  const fallbackFile = path.join(SCRATCH_DIR, filename);
  try {
     const st = await fs.stat(fallbackFile);
     if (st.size > 0) {
         console.log(`Using fallback local file for ${endpoint}`);
         const content = await fs.readFile(fallbackFile, "utf-8");
         allData.push(...JSON.parse(content));
     }
  } catch (e) {}

  if (allData.length === 0) {
      while (true) {
        try {
          const data = await fetchPage(endpoint, page, limit);
          if (data === null) break;
          let items = Array.isArray(data) ? data : data.data;
          if (!items) items = data.items || data.results; 
          if (!Array.isArray(items)) {
             if (page === 1) allData.push(data);
             break;
          }
          
          allData.push(...items);
          console.log(`Fetched page ${page} (${items.length} items). Total so far: ${allData.length}`);
          
          if (items.length < limit) break; 
          page++;
        } catch (err) {
          console.error(err);
          break;
        }
      }
  }
  
  if (allData.length > 0) {
      const outPath = path.join(SCRATCH_DIR, filename);
      await fs.writeFile(outPath, JSON.stringify(allData, null, 2));
      console.log(`Saved ${allData.length} records to ${filename}`);
      
      try { await uploadToR2(s3, filename, allData); } catch (e: any) { console.error("R2 Upload failed:", e.message); }
      await postObservations(adminToken, allData);
  }
}

async function main() {
  const s3 = await getS3();
  const tokenRes = await resolveSecret(Deno.env.toObject() as any, "ADMIN_TOKEN");
  const adminToken = tokenRes.value || Deno.env.get("ADMIN_TOKEN") || "";

  if (!adminToken) {
      console.warn("WARNING: ADMIN_TOKEN is missing. Cannot post to /api/admin/backfill-observations");
  }

  await hoardPaginated('/congress/recent-trades', 'uw_recent_trades.json', s3, adminToken);
  await hoardPaginated('/congress/late-reports', 'uw_late_reports.json', s3, adminToken);
  await hoardPaginated('/congress/politicians', 'uw_politicians.json', s3, adminToken);
}

main().catch(console.error);
