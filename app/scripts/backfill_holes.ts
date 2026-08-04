import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { createClient } from "npm:@libsql/client";
import {
  assetNameFromCompetitorPayload,
  resolveExecutiveFilerIdFromName,
} from "../src/shared/executiveIdentity.ts";

function mapTxType(raw: string | undefined): "P" | "S" | "E" {
  const t = (raw ?? "").toLowerCase();
  if (t.includes("exchange")) return "E";
  if (t.includes("sale") || t.includes("sell")) return "S";
  return "P";
}

function filerIdForHole(h: { lastName?: string; name?: string; fullName?: string; raw?: { name?: string } }): string {
  const full =
    h.fullName ||
    h.name ||
    (h.raw && typeof h.raw === "object" ? (h.raw as { name?: string }).name : "") ||
    "";
  const exec = resolveExecutiveFilerIdFromName(full);
  if (exec) return exec;
  // Never map bare last name → EXEC-*. House members sharing a last name
  // (e.g. Rich McCormick) stay on MANUAL-*.
  const last = (h.lastName || full.split(/\s+/).pop() || "UNKNOWN").toUpperCase().replace(/[^A-Z]/g, "");
  return `MANUAL-${last || "UNKNOWN"}`;
}

async function main() {
  const env = await load({ envPath: "/Users/jay/Code/Congress.Trade/app/.prod.vars" });
  const client = createClient({
    url: env.TURSO_DATABASE_URL || env.TURSO_URL || "",
    authToken: env.TURSO_AUTH_TOKEN || "",
  });

  const holesJson = await Deno.readTextFile(
    "/Users/jay/.gemini/antigravity/brain/46787371-bd2d-4703-a05d-cf01380534f5/data_holes.json",
  );
  const holes = JSON.parse(holesJson);

  console.log(`Loaded ${holes.length} missing trades.`);

  const txBatch = [];

  for (const h of holes) {
    const filerId = filerIdForHole(h);
    const txType = mapTxType(h.type);
    const assetName = assetNameFromCompetitorPayload(h.raw ?? h, h.ticker);
    const ticker = h.ticker && String(h.ticker).toUpperCase() !== "UNKNOWN" ? h.ticker : null;

    const docId = `COMPETITOR-${h.provider}-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();

    txBatch.push({
      sql: `INSERT OR IGNORE INTO transactions (
        id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type, tx_type, amount_min, amount_max, is_option, cap_gains_over_200, raw_text, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        docId,
        filerId,
        h.date,
        "unknown",
        assetName,
        ticker,
        "stock",
        txType,
        1001,
        15000,
        0,
        0,
        JSON.stringify(h.raw ?? h),
        "competitor_backfill",
        new Date().toISOString(),
      ],
    });
  }

  console.log(`Executing ${txBatch.length} insertions...`);

  let successCount = 0;
  for (let i = 0; i < txBatch.length; i += 100) {
    const chunk = txBatch.slice(i, i + 100);
    await client.batch(chunk, "write");
    successCount += chunk.length;
    console.log(`Inserted ${successCount} / ${txBatch.length}`);
  }

  console.log("Backfill complete.");
}

main().catch(console.error);
