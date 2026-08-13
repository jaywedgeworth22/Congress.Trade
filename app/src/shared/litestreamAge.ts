/** Best-effort local L0 LTX age so /api/health can feed Usage Monitor. */

export const DEFAULT_CT_LTX0_DIR = "/data/congress-trade/.db.sqlite-litestream/ltx/0";

export interface LocalLitestreamAge {
  litestreamAgeSeconds: number | null;
  litestreamLastSyncAt: string | null;
  litestreamStatus: "replicating" | "unknown";
}

const UNKNOWN: LocalLitestreamAge = {
  litestreamAgeSeconds: null,
  litestreamLastSyncAt: null,
  litestreamStatus: "unknown",
};

export async function readLocalLitestreamAge(
  dir: string = DEFAULT_CT_LTX0_DIR,
): Promise<LocalLitestreamAge> {
  const readDir = (globalThis as { Deno?: { readDir: (p: string) => AsyncIterable<{ name: string; isFile: boolean }> } }).Deno
    ?.readDir;
  const stat = (globalThis as { Deno?: { stat: (p: string) => Promise<{ mtime?: Date | null }> } }).Deno
    ?.stat;
  if (!readDir || !stat) return UNKNOWN;
  try {
    let newest = 0;
    for await (const entry of readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".ltx")) continue;
      const info = await stat(`${dir.replace(/\/$/, "")}/${entry.name}`);
      const ms = info.mtime?.getTime() ?? 0;
      if (ms > newest) newest = ms;
    }
    if (!newest) return UNKNOWN;
    const age = Math.max(0, (Date.now() - newest) / 1000);
    return {
      litestreamAgeSeconds: age,
      litestreamLastSyncAt: new Date(newest).toISOString(),
      litestreamStatus: age < 15 * 60 ? "replicating" : "unknown",
    };
  } catch {
    return UNKNOWN;
  }
}
