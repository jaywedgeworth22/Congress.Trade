# Member face pack

Our own repository of member portraits: one square, head-focused 256px WebP per
person under `app/public/assets/member-photos/`, plus a `manifest.json` that
records where each original came from and under what licence.

## Why it exists

Before this, `filers.photo_url` was a hotlink to
`unitedstates.github.io/images/congress/450x550/{bioguide}.jpg`.  That is a good
public-domain source, but it left three problems on the live site:

| Problem | Effect |
| --- | --- |
| Only covers people with a bioguide | Every executive-branch filer — cabinet secretaries, agency heads, Senate-confirmed nominees — had no photo at all |
| Some stored bioguides 404 upstream | The dashboard's `onerror="this.remove()"` hid the breakage instead of reporting it |
| Framing is head **and torso** | In a circular row avatar the face lands small and off-centre |

The pack fixes all three, and it costs about 2.4 MB in the repo for ~340 faces.

## Running it

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/member-photos/requirements.txt

# Rebuild everything from the live member list.
.venv/bin/python scripts/member-photos/build_face_pack.py \
    --contact-sheet /tmp/faces.png

# One person, or one branch.
.venv/bin/python scripts/member-photos/build_face_pack.py --keys B001300
.venv/bin/python scripts/member-photos/build_face_pack.py --only executive
```

Re-run it whenever new members show up in `/api/members`; the congressional
bioguide set is derived from that response, so nothing has to be listed by hand.

**Always look at the contact sheet.**  It is the only cheap way to catch a
detector that quietly framed somebody's chin.  Faces cropped without a face
detection are prefixed `!` on the sheet and listed in the run output.

## Sources and licences

Only public-domain originals ship.  `facepack.is_public_domain_licence` gates
every entry, and the licence is copied into `manifest.json` next to the image.

* **Congress** — `unitedstates/images`, public domain, keyed by bioguide.
  Nothing to curate; the script resolves these automatically.
* **Executive, and bioguides upstream does not carry** — curated in
  `sources.json`.  Each entry names the Wikimedia Commons file, the direct
  source URL, the verified licence and the attribution.

`discover_commons.py` produces those entries.  It searches Commons, then asks
the API for `extmetadata.LicenseShortName` and keeps only public-domain files:

```bash
.venv/bin/python scripts/member-photos/discover_commons.py \
    --names-file names.txt --json /tmp/candidates.json

# Describe one exact file (never hand-write an upload.wikimedia.org URL —
# the path contains an MD5 shard you cannot derive from the file name).
.venv/bin/python scripts/member-photos/discover_commons.py \
    --file "File:ED Sec Linda McMahon (cropped).jpg"
```

Candidates are scored, not blindly taken: the file title must contain the
subject's surname, and group shots, landscape framing and hearing screengrabs
are pushed down.  **The licence check is automatic; the identity check is not.**
Review the candidate list, then verify the built faces on the contact sheet.

If a person has no public-domain portrait, leave them out and record why in the
`unresolved` block of `sources.json`.  A gap is cheaper than an unlicensed face
on a public site.

## Cropping

`facepack.head_crop_box` derives a square from the detected face box, reserving
`0.62` face-heights of headroom above and `0.85` below.  When the image is too
small for the ideal square, both reservations shrink by the same factor so the
face keeps its relative position.

Face detection (OpenCV Haar cascade) is **optional**.  Without it — or when
detection fails — the crop falls back to a top-anchored square covering 72% of
the image height, which is safe for a standard studio portrait.  The fallback is
deliberately loose: a bad detection should degrade to "slightly wide", never to
"top of head missing".

## Serving

`app/src/enrichment/memberPhotoPack.ts` reads the manifest once per process and
serves `GET /api/photos/member?key=…`:

1. the committed pack (one-year cache — faces only change on redeploy),
2. for a bioguide-shaped key, the upstream public-domain CDN (one-day cache),
3. otherwise a short-cached `204` — not a `404`, so a miss does not error in the
   browser console.

`runPhotoEnrichment` (`app/src/admin/routes.ts`) writes the **absolute** pack URL
into `filers.photo_url` for anyone the pack covers, and fills executive filers by
filer id.  Absolute, because `photo_url` is handed to the SwiftUI clients as-is
and a path-only value would not resolve there.
