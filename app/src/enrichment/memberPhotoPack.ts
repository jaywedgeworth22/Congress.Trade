/**
 * src/enrichment/memberPhotoPack.ts
 * OWNER: enrichment
 *
 * Our own repository of member faces.
 *
 * Before this existed, every member photo was a hotlink to
 * `unitedstates.github.io/images/congress/450x550/{bioguide}.jpg` — which is a
 * fine public-domain source but has three problems:
 *
 *   1. it only covers people with a bioguide, so every executive-branch filer
 *      (cabinet secretaries, agency heads, Senate-confirmed nominees) was a
 *      permanent gap;
 *   2. a handful of bioguides 404 there, and the dashboard's
 *      `onerror="this.remove()"` hid the breakage instead of reporting it; and
 *   3. the framing is a 450x550 head-and-torso portrait, so in a circular row
 *      avatar the face ends up small and off-centre.
 *
 * The pack fixes all three: `scripts/member-photos/build_face_pack.py` crops
 * every source portrait to a square, head-focused 256px WebP and commits it to
 * `app/public/assets/member-photos/` alongside a `manifest.json` recording, per
 * face, the original source URL and its licence. Only public-domain originals
 * are shipped — see that script and `sources.json`.
 *
 * Serving mirrors `ui/tickerLogos.ts`: one cached proxy route so the client
 * only ever sees `/api/photos/member?key=…`, the pack answers first, and a
 * bioguide key that is not in the pack falls back to the upstream CDN rather
 * than 404ing. A genuine miss is a short-cached 204, not an error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public/assets/member-photos');
const MANIFEST_PATH = join(PACK_DIR, 'manifest.json');

/** Pack keys are a bioguide id (congress) or a person slug (executive). */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/i;
/** Filenames the pack is allowed to read: a bare image name, no path parts. */
const SAFE_PACK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(webp|png|jpe?g)$/;

const UPSTREAM_CONGRESS = 'https://unitedstates.github.io/images/congress';
export const LEGISLATOR_PHOTO_SIZE = '450x550';

const ONE_DAY_SECONDS = 86_400;
const ONE_WEEK_SECONDS = 604_800;
const ONE_YEAR_SECONDS = 31_536_000;
/** Below this a "WebP"/"JPEG" is almost certainly empty or truncated. */
const MIN_IMAGE_BYTES = 64;

export interface MemberFace {
  key: string;
  name: string;
  branch: 'congress' | 'executive';
  bioguide: string | null;
  filerIds: string[];
  file: string;
  sourceUrl: string;
  sourcePage: string | null;
  licence: string;
  attribution: string | null;
  cropMode: string;
  bytes: number;
  sha256: string;
}

interface PackIndex {
  byKey: Map<string, MemberFace>;
  byFilerId: Map<string, MemberFace>;
  totalBytes: number;
}

let cachedIndex: PackIndex | null = null;

function emptyIndex(): PackIndex {
  return { byKey: new Map(), byFilerId: new Map(), totalBytes: 0 };
}

/**
 * Read + index the committed manifest once per process.
 *
 * A missing or malformed manifest is not fatal: the pack is an optimisation
 * over the upstream CDN, so an empty index degrades to today's behaviour
 * rather than taking member photos down.
 */
export function memberPhotoPack(): PackIndex {
  if (cachedIndex) return cachedIndex;
  cachedIndex = emptyIndex();
  try {
    if (!existsSync(MANIFEST_PATH)) return cachedIndex;
    const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { faces?: MemberFace[] };
    for (const face of parsed.faces ?? []) {
      if (!face?.key || !face?.file) continue;
      cachedIndex.byKey.set(face.key, face);
      cachedIndex.totalBytes += Number(face.bytes) || 0;
      for (const filerId of face.filerIds ?? []) {
        if (filerId && !cachedIndex.byFilerId.has(filerId)) cachedIndex.byFilerId.set(filerId, face);
      }
    }
  } catch {
    cachedIndex = emptyIndex();
  }
  return cachedIndex;
}

/** Test seam: drop the memoised manifest so a fixture pack can be re-read. */
export function resetMemberPhotoPackCache(): void {
  cachedIndex = null;
}

export function packFaceForKey(key: string | null | undefined): MemberFace | null {
  const normalized = normalizeMemberPhotoKey(key);
  return normalized ? memberPhotoPack().byKey.get(normalized) ?? null : null;
}

/** Every packed face that names at least one filer id (executive-branch fills). */
export function packFacesWithFilerIds(): MemberFace[] {
  return [...memberPhotoPack().byKey.values()].filter((f) => (f.filerIds ?? []).length > 0);
}

export function packFaceForFilerId(filerId: string | null | undefined): MemberFace | null {
  const id = (filerId ?? '').trim();
  return id ? memberPhotoPack().byFilerId.get(id) ?? null : null;
}

/** Reject anything that is not a plain key — no traversal, no separators. */
export function normalizeMemberPhotoKey(value: string | null | undefined): string | null {
  const key = (value ?? '').trim();
  if (!key || key.includes('..') || key.includes('/') || key.includes('\\')) return null;
  return KEY_PATTERN.test(key) ? key : null;
}

/** Upstream public-domain congressional portrait for a bioguide. */
export function upstreamCongressPhotoUrl(bioguide: string, size = LEGISLATOR_PHOTO_SIZE): string {
  return `${UPSTREAM_CONGRESS}/${size}/${bioguide}.jpg`;
}

/**
 * Absolute URL for a packed face.
 *
 * Absolute, not relative: `photo_url` is handed to the SwiftUI clients as-is,
 * and a path-only value would not resolve there.
 */
export function memberPhotoUrl(key: string, baseUrl: string): string {
  const origin = (baseUrl || 'https://congress.trade').replace(/\/+$/, '');
  return `${origin}/api/photos/member?key=${encodeURIComponent(key)}`;
}

/** True when a stored photo_url already points at this deployment's pack route. */
export function isMemberPhotoPackUrl(value: string | null | undefined): boolean {
  return /\/api\/photos\/member\?key=/.test((value ?? '').trim());
}

/** Pack key encoded in a pack URL, if it is one. */
export function packKeyFromUrl(value: string | null | undefined): string | null {
  const match = /\/api\/photos\/member\?key=([^&\s]+)/.exec((value ?? '').trim());
  if (!match) return null;
  try {
    return normalizeMemberPhotoKey(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

function contentTypeFor(file: string): string {
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}

function imageResponse(bytes: Uint8Array, contentType: string, source: string, maxAge: number): Response {
  // Fresh ArrayBuffer-backed copy so Response accepts it under Deno and Node.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy, {
    headers: {
      'cache-control': `public, max-age=${maxAge}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
      'content-type': contentType,
      'content-length': String(copy.byteLength),
      'x-photo-source': source,
    },
  });
}

/** Read the committed file for a pack entry, or null when it is missing/empty. */
export function tryLocalMemberPhoto(key: string): Response | null {
  const face = packFaceForKey(key);
  if (!face) return null;
  // The manifest is committed alongside the images, but it is still data read
  // off disk — never let a filename in it escape the pack directory.
  if (!SAFE_PACK_FILE.test(face.file)) return null;
  const abs = join(PACK_DIR, face.file);
  if (!existsSync(abs)) return null;
  try {
    const bytes = new Uint8Array(readFileSync(abs));
    if (bytes.byteLength < MIN_IMAGE_BYTES) return null;
    // Faces are content-addressed by the manifest and only change when the pack
    // is rebuilt and redeployed, so they can be cached for a year.
    return imageResponse(bytes, contentTypeFor(face.file), `pack:${face.file}`, ONE_YEAR_SECONDS);
  } catch {
    return null;
  }
}

/** Bioguide-shaped keys can still be answered by the upstream CDN. */
function bioguideFromKey(key: string): string | null {
  return /^[A-Z]\d{6}$/i.test(key) ? key.toUpperCase() : null;
}

/**
 * `GET /api/photos/member?key=…` — pack first, upstream congressional CDN
 * second, short-cached 204 on a genuine miss.
 */
export async function handleMemberPhotoRequest(url: URL): Promise<Response> {
  const key = normalizeMemberPhotoKey(url.searchParams.get('key'));
  if (!key) {
    return new Response(JSON.stringify({ error: 'key is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const local = tryLocalMemberPhoto(key);
  if (local) return local;

  const bioguide = bioguideFromKey(key);
  if (bioguide) {
    try {
      const upstream = await trackedFetch(
        upstreamCongressPhotoUrl(bioguide),
        {
          headers: { accept: 'image/jpeg,image/*;q=0.8' },
          cf: { cacheTtl: ONE_WEEK_SECONDS, cacheEverything: true },
        },
        { service: 'asset-photo', operation: 'fetch-member-photo-upstream' },
      );
      if (upstream.ok) {
        const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
        if (!contentType || contentType.startsWith('image/')) {
          const bytes = new Uint8Array(await upstream.arrayBuffer());
          if (bytes.byteLength >= MIN_IMAGE_BYTES) {
            return imageResponse(bytes, contentType || 'image/jpeg', 'upstream:unitedstates', ONE_DAY_SECONDS);
          }
        }
      }
    } catch {
      /* fall through to the miss response */
    }
  }

  // 204 (not 404) so a genuine miss does not error in the browser console, and
  // a short TTL so a newly built pack shows up within minutes.
  return new Response(null, { status: 204, headers: { 'cache-control': 'public, max-age=300' } });
}
