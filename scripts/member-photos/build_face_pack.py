#!/usr/bin/env python3
"""Build the Congress.Trade member face pack.

Downloads each member's public-domain source portrait, crops it to a square
head-and-shoulders face, writes a 256px WebP into
``app/public/assets/member-photos/`` and records source + licence for every
image in ``manifest.json``.

Re-runnable: existing faces are refreshed in place, and members that are not
in the input set are left alone (pass ``--prune`` to drop orphans).

Sources
-------
* **Congress** -- ``unitedstates/images`` (public domain, bioguide-keyed).  The
  bioguide set is derived from the live ``/api/members`` response: every member
  whose ``photoUrl`` already points at that CDN.  New members appear in the API,
  re-run this script, and they join the pack.
* **Executive** -- curated entries in ``sources.json``, each carrying the
  Commons file, direct source URL, licence and attribution that
  ``discover_commons.py`` verified.  Only public-domain licences are accepted;
  anything else is reported and skipped so the gap stays visible.

Usage
-----
    python3 -m venv .venv
    .venv/bin/pip install -r scripts/member-photos/requirements.txt
    .venv/bin/python scripts/member-photos/build_face_pack.py
    .venv/bin/python scripts/member-photos/build_face_pack.py --contact-sheet /tmp/faces.png

``--contact-sheet`` writes a labelled grid of every produced face.  Look at it.
It is the only cheap way to catch a detector that quietly framed somebody's
chin, and it is why the fallback crop is deliberately loose.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image, ImageDraw  # noqa: E402

import facepack as fp  # noqa: E402

USER_AGENT = "CongressTrade-FacePack/1.0 (+https://congress.trade)"
MEMBERS_URL = "https://congress.trade/api/members"
# `original` is the largest unitedstates/images size; cropping from it and
# downsampling to 256 beats cropping the already-downsampled 450x550.
CONGRESS_SOURCE = "https://unitedstates.github.io/images/congress/original/{bioguide}.jpg"
CONGRESS_FALLBACK = "https://unitedstates.github.io/images/congress/450x550/{bioguide}.jpg"
CONGRESS_LICENCE = "Public domain (CC0 1.0 Universal)"
CONGRESS_ATTRIBUTION = "unitedstates/images — public-domain congressional portraits"
CONGRESS_SOURCE_PAGE = "https://github.com/unitedstates/images"

BIOGUIDE_IN_URL = re.compile(r"/images/congress/[^/]+/([A-Z]\d{6})\.jpg", re.I)


# Wikimedia throttles hard (HTTP 429) and asks bots to self-limit. Keep a
# per-host floor between requests and back off on 429/5xx rather than burning
# through the run and leaving half the executives unfilled.
HOST_MIN_INTERVAL = {"upload.wikimedia.org": 1.2, "commons.wikimedia.org": 1.2}
_last_hit: dict[str, float] = {}


def fetch(url: str, timeout: int = 45, attempts: int = 4) -> bytes:
    host = urllib.parse.urlparse(url).netloc
    floor = HOST_MIN_INTERVAL.get(host, 0.0)
    delay = 2.0
    last: Exception | None = None
    for attempt in range(attempts):
        if floor:
            gap = time.monotonic() - _last_hit.get(host, 0.0)
            if gap < floor:
                time.sleep(floor - gap)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except urllib.error.HTTPError as exc:
            last = exc
            # 404 is a real answer ("no such portrait"); retrying wastes time.
            if exc.code not in (429, 500, 502, 503, 504):
                raise
        except (urllib.error.URLError, OSError) as exc:
            last = exc
        finally:
            _last_hit[host] = time.monotonic()
        if attempt < attempts - 1:
            time.sleep(delay)
            delay *= 2
    raise last if last else RuntimeError(f"fetch failed: {url}")


def load_members(members_url: str | None, members_json: Path | None) -> list[dict]:
    if members_json:
        return json.loads(members_json.read_text(encoding="utf-8")).get("members", [])
    raw = fetch(members_url or MEMBERS_URL)
    return json.loads(raw.decode("utf-8")).get("members", [])


def congress_targets(members: list[dict]) -> dict[str, dict]:
    """bioguide -> {name, filerIds} for every member already keyed to the CDN."""
    targets: dict[str, dict] = {}
    for m in members:
        match = BIOGUIDE_IN_URL.search(m.get("photoUrl") or "")
        if not match:
            continue
        bioguide = match.group(1).upper()
        entry = targets.setdefault(
            bioguide, {"name": m.get("fullName") or bioguide, "filerIds": []}
        )
        filer_id = m.get("filerId")
        if filer_id and filer_id not in entry["filerIds"]:
            entry["filerIds"].append(filer_id)
    return targets


def save_face(image: Image.Image, path: Path) -> bytes:
    buf = io.BytesIO()
    image.save(buf, "WEBP", quality=fp.WEBP_QUALITY, method=6)
    data = buf.getvalue()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def process(
    key: str,
    name: str,
    branch: str,
    urls: list[str],
    licence: str,
    attribution: str | None,
    source_page: str | None,
    pack_dir: Path,
    bioguide: str | None = None,
    filer_ids: list[str] | None = None,
) -> tuple[fp.FaceEntry | None, str | None]:
    """Download the first URL that works, crop, write. Returns (entry, error)."""
    last_error = None
    for url in urls:
        try:
            raw = fetch(url)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            continue
        try:
            image = Image.open(io.BytesIO(raw))
            image.load()
        except Exception as exc:  # noqa: BLE001 - any decode failure is a skip
            last_error = f"decode failed: {exc}"
            continue
        face, mode, _ = fp.render_face(image)
        data = save_face(face, pack_dir / f"{key}.webp")
        return (
            fp.FaceEntry(
                key=key,
                name=name,
                branch=branch,
                file=f"{key}.webp",
                source_url=url,
                source_page=source_page,
                licence=licence,
                attribution=attribution,
                crop_mode=mode,
                bytes=len(data),
                sha256=fp.sha256_bytes(data),
                bioguide=bioguide,
                filer_ids=filer_ids or [],
            ),
            None,
        )
    return None, last_error or "no source url"


def contact_sheet(entries: list[fp.FaceEntry], pack_dir: Path, out: Path, cols: int = 10) -> None:
    cell, label = 128, 16
    rows = (len(entries) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + label)), "white")
    draw = ImageDraw.Draw(sheet)
    for i, entry in enumerate(sorted(entries, key=lambda e: (e.crop_mode != "fallback", e.key))):
        row, col = divmod(i, cols)
        img = Image.open(pack_dir / entry.file).convert("RGB").resize((cell, cell), Image.LANCZOS)
        sheet.paste(img, (col * cell, row * (cell + label)))
        tag = entry.key if entry.crop_mode == "face" else f"!{entry.key}"
        draw.text((col * cell + 2, row * (cell + label) + cell + 2), tag[:20], fill="black")
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--members-url", default=MEMBERS_URL)
    ap.add_argument("--members-json", type=Path, help="Offline /api/members payload instead of a live fetch.")
    ap.add_argument("--sources", type=Path, default=fp.SOURCES_PATH)
    ap.add_argument("--pack-dir", type=Path, default=fp.PACK_DIR)
    ap.add_argument("--only", choices=["congress", "executive"], help="Rebuild one branch only.")
    ap.add_argument("--keys", nargs="*", help="Rebuild only these pack keys.")
    ap.add_argument("--prune", action="store_true", help="Delete pack files no longer in the input set.")
    ap.add_argument("--contact-sheet", type=Path, help="Write a labelled QA grid of every face here.")
    ap.add_argument("--sleep", type=float, default=0.15, help="Delay between source fetches.")
    args = ap.parse_args()

    if not fp.face_detection_available():
        print(
            "note: OpenCV not installed — every crop will use the deterministic "
            "fallback framing. Install requirements.txt for face-centred crops.",
            file=sys.stderr,
        )

    sources = json.loads(args.sources.read_text(encoding="utf-8"))
    pack_dir: Path = args.pack_dir
    pack_dir.mkdir(parents=True, exist_ok=True)

    entries: list[fp.FaceEntry] = []
    skipped: list[tuple[str, str]] = []
    wanted = set(args.keys or [])

    # Bioguides unitedstates/images does not carry (newly seated members, and
    # historical bioguides that predate photography) get a curated PD source.
    overrides = {o["bioguide"]: o for o in sources.get("congressOverrides", [])}

    if args.only != "executive":
        members = load_members(args.members_url, args.members_json)
        targets = congress_targets(members)
        for bioguide, override in overrides.items():
            targets.setdefault(bioguide, {"name": override["name"], "filerIds": override.get("filerIds", [])})
        print(f"congress: {len(targets)} bioguides from {len(members)} members "
              f"({len(overrides)} curated overrides)")
        for bioguide, meta in sorted(targets.items()):
            key = bioguide
            if wanted and key not in wanted:
                continue
            override = overrides.get(bioguide)
            if override:
                if not fp.is_public_domain_licence(override.get("licence")):
                    skipped.append((key, f"licence not public domain: {override.get('licence')!r}"))
                    continue
                urls = [override["sourceUrl"]]
                licence, attribution, source_page = (
                    override["licence"],
                    override.get("attribution"),
                    override.get("sourcePage"),
                )
            else:
                urls = [
                    CONGRESS_SOURCE.format(bioguide=bioguide),
                    CONGRESS_FALLBACK.format(bioguide=bioguide),
                ]
                licence, attribution, source_page = (
                    CONGRESS_LICENCE,
                    CONGRESS_ATTRIBUTION,
                    CONGRESS_SOURCE_PAGE,
                )
            entry, err = process(
                key=key,
                name=meta["name"],
                branch="congress",
                urls=urls,
                licence=licence,
                attribution=attribution,
                source_page=source_page,
                pack_dir=pack_dir,
                bioguide=bioguide,
                filer_ids=meta["filerIds"],
            )
            if entry:
                entries.append(entry)
            else:
                skipped.append((key, err or "unknown"))
            time.sleep(args.sleep)

    if args.only != "congress":
        execs = sources.get("executives", [])
        print(f"executive: {len(execs)} curated entries")
        for item in execs:
            key = item["key"]
            if wanted and key not in wanted:
                continue
            licence = item.get("licence") or ""
            if not fp.is_public_domain_licence(licence):
                skipped.append((key, f"licence not public domain: {licence!r}"))
                continue
            if not item.get("sourceUrl"):
                skipped.append((key, "no sourceUrl — left as a gap for the owner"))
                continue
            entry, err = process(
                key=key,
                name=item["name"],
                branch="executive",
                urls=[item["sourceUrl"]],
                licence=licence,
                attribution=item.get("attribution"),
                source_page=item.get("sourcePage"),
                pack_dir=pack_dir,
                filer_ids=item.get("filerIds", []),
            )
            if entry:
                entries.append(entry)
            else:
                skipped.append((key, err or "unknown"))
            time.sleep(args.sleep)

    # Merge with anything already in the manifest that this run did not touch,
    # so `--only` / `--keys` runs never silently drop the other half.
    existing = {f["key"]: f for f in fp.load_manifest(pack_dir / "manifest.json").get("faces", [])}
    produced = {e.key for e in entries}
    merged = list(entries)
    for key, raw in existing.items():
        if key in produced:
            continue
        if not (pack_dir / raw["file"]).exists():
            continue
        merged.append(
            fp.FaceEntry(
                key=raw["key"],
                name=raw["name"],
                branch=raw["branch"],
                file=raw["file"],
                source_url=raw["sourceUrl"],
                source_page=raw.get("sourcePage"),
                licence=raw["licence"],
                attribution=raw.get("attribution"),
                crop_mode=raw.get("cropMode", "face"),
                bytes=raw["bytes"],
                sha256=raw["sha256"],
                bioguide=raw.get("bioguide"),
                filer_ids=raw.get("filerIds", []),
            )
        )

    if args.prune:
        keep = {e.file for e in merged}
        for path in pack_dir.glob("*.webp"):
            if path.name not in keep:
                path.unlink()
                print(f"pruned {path.name}")

    payload = fp.write_manifest(merged, pack_dir / "manifest.json")

    fallbacks = [e.key for e in merged if e.crop_mode == "fallback"]
    print(f"\nwrote {payload['count']} faces, {payload['totalBytes'] / 1e6:.2f} MB total")
    print(f"face-detected crops: {payload['count'] - len(fallbacks)}, fallback crops: {len(fallbacks)}")
    if fallbacks:
        print("  fallback (eyeball these on the contact sheet): " + ", ".join(sorted(fallbacks)))
    if skipped:
        print(f"\nskipped {len(skipped)} — these stay as gaps:")
        for key, why in skipped:
            print(f"  {key}: {why}")

    if args.contact_sheet:
        contact_sheet(merged, pack_dir, args.contact_sheet)
        print(f"\ncontact sheet: {args.contact_sheet}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
