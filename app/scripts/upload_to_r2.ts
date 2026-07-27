import * as fs from "node:fs/promises";
import * as path from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { resolveSecret } from "../src/secrets/infisical.ts";

async function getS3() {
  const s3EpRes = await resolveSecret(Deno.env.toObject() as any, "AWS_S3_ENDPOINT");
  const s3IdRes = await resolveSecret(Deno.env.toObject() as any, "AWS_ACCESS_KEY_ID");
  const s3SecRes = await resolveSecret(Deno.env.toObject() as any, "AWS_SECRET_ACCESS_KEY");
  
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

const BUCKET = "congress-trade-bucket";
const SCRATCH_DIR = "/Users/jay/.gemini/antigravity/brain/46787371-bd2d-4703-a05d-cf01380534f5/scratch";

async function uploadFile(s3: S3Client, filepath: string, objectKey: string) {
  try {
    const data = await fs.readFile(filepath);
    console.log(`Uploading ${filepath} to ${BUCKET}/${objectKey} (${data.length} bytes)...`);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: objectKey,
      Body: data,
      ContentType: "application/json"
    }));
    console.log(`Successfully uploaded ${objectKey}`);
  } catch (e) {
    console.error(`Failed to upload ${filepath}:`, e);
  }
}

async function main() {
  const s3 = await getS3();
  const dateStr = new Date().toISOString().split('T')[0];
  const filesToUpload = [
    { file: "qq_bulk_congresstrading.json", key: `competitors/quiverquant/${dateStr}/qq_bulk_congresstrading.json` },
    { file: "qq_bulk_trumpstocktrades.json", key: `competitors/quiverquant/${dateStr}/qq_bulk_trumpstocktrades.json` },
    { file: "uw_recent_trades.json", key: `competitors/unusualwhales/${dateStr}/uw_recent_trades.json` },
    { file: "uw_late_reports.json", key: `competitors/unusualwhales/${dateStr}/uw_late_reports.json` },
    { file: "uw_politicians.json", key: `competitors/unusualwhales/${dateStr}/uw_politicians.json` }
  ];

  for (const item of filesToUpload) {
    const fullPath = path.resolve(SCRATCH_DIR, item.file);
    await uploadFile(s3, fullPath, item.key);
  }
}

main();
