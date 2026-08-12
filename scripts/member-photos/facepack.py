#!/usr/bin/env python3
"""Shared helpers for the Congress.Trade member face pack.

The pack is a small, committed set of square, head-focused portraits under
``app/public/assets/member-photos/`` plus a ``manifest.json`` that records, for
every face, where the original came from and under what licence.  Nothing here
talks to the app or the database -- the scripts in this directory are offline
tooling that produce files the Worker/Deno server then serves.

Two rules the crop engine exists to enforce:

1.  **Head and shoulders, consistently.**  Source portraits (the
    unitedstates/images congressional set, agency portraits on Commons) frame
    the subject anywhere from mid-torso to shoulders.  Dropped straight into a
    circular avatar they read as "a suit with a small head on top".  We crop to
    a square whose size is derived from the detected face box.

2.  **Never a chin-only crop.**  Face detection is optional -- if OpenCV is not
    installed, or the detector misses, we fall back to a fixed proportional
    crop that is safe for a standard portrait.  Either way the geometry
    reserves explicit headroom above the face and shoulder room below it, so a
    bad detection degrades to "slightly loose" and never to "top of head
    missing".

Install the optional detector with::

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
PACK_DIR = REPO_ROOT / "app/public/assets/member-photos"
MANIFEST_PATH = PACK_DIR / "manifest.json"
SOURCES_PATH = Path(__file__).resolve().parent / "sources.json"

# Output geometry.  256px square is ample for a retina row avatar (44pt @3x =
# 132px) and for the politician drawer's larger circle; going bigger multiplies
# committed bytes for pixels nothing renders.
OUTPUT_SIZE = 256
WEBP_QUALITY = 82

# Crop geometry, expressed in multiples of the detected face-box height.  The
# face box a Haar frontal-face cascade returns spans roughly eyebrows-to-chin,
# so "above" has to cover forehead + hair and "below" covers chin + neck +
# a little shoulder.
HEADROOM_ABOVE = 0.62
ROOM_BELOW = 0.85

# Fallback crop (no detector, or no face found): take a square this fraction of
# the image height, starting near the top.  Tuned for standard studio portraits
# where the head occupies the upper half of the frame.
FALLBACK_HEIGHT_FRACTION = 0.72
FALLBACK_TOP_FRACTION = 0.03

# Licences we accept into the pack.  Anything else is reported and skipped --
# an unlicensed face on a public site is a liability, so an unclear provenance
# must leave a gap rather than guess.
PUBLIC_DOMAIN_LICENCE_PATTERNS = (
    re.compile(r"^public domain$", re.I),
    re.compile(r"^pd([-\s]|$)", re.I),
    re.compile(r"^cc0", re.I),
    re.compile(r"us[-\s]?gov", re.I),
)


def is_public_domain_licence(short_name: str | None) -> bool:
    """True when a Commons ``LicenseShortName`` is one we are willing to ship."""
    value = (short_name or "").strip()
    if not value:
        return False
    return any(p.search(value) for p in PUBLIC_DOMAIN_LICENCE_PATTERNS)


def slugify(value: str) -> str:
    """Stable, filesystem- and URL-safe key for a person ("Scott Bessent" -> "scott-bessent")."""
    folded = unicodedata.normalize("NFKD", value or "")
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    folded = folded.lower().replace("'", "").replace("’", "")
    folded = re.sub(r"[^a-z0-9]+", "-", folded).strip("-")
    return re.sub(r"-{2,}", "-", folded)


# ---------------------------------------------------------------------------
# Face detection (optional)
# ---------------------------------------------------------------------------

_CASCADE = None
_CASCADE_TRIED = False


def _cascade():
    """Load the Haar frontal-face cascade once; return None when unavailable."""
    global _CASCADE, _CASCADE_TRIED
    if _CASCADE_TRIED:
        return _CASCADE
    _CASCADE_TRIED = True
    try:
        import cv2  # type: ignore

        path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
        if not path.exists():
            return None
        clf = cv2.CascadeClassifier(str(path))
        _CASCADE = None if clf.empty() else clf
    except Exception:
        _CASCADE = None
    return _CASCADE


def face_detection_available() -> bool:
    """True when the optional OpenCV face detector is usable."""
    return _cascade() is not None


def detect_face(image: Image.Image) -> tuple[int, int, int, int] | None:
    """Return the dominant face box ``(x, y, w, h)``, or None when undetectable.

    Three passes from strict to permissive: a confident detection on the first
    pass is worth more than a loose one, and a portrait that only registers at
    ``scaleFactor=1.2`` is still better centred than the blind fallback.
    """
    clf = _cascade()
    if clf is None:
        return None
    try:
        import cv2  # type: ignore
        import numpy as np

        gray = cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2GRAY)
        gray = cv2.equalizeHist(gray)
        floor = int(min(gray.shape) * 0.10)
        for scale_factor, min_neighbors in ((1.06, 6), (1.10, 4), (1.20, 3)):
            found = clf.detectMultiScale(
                gray,
                scaleFactor=scale_factor,
                minNeighbors=min_neighbors,
                minSize=(floor, floor),
            )
            if len(found):
                # Biggest face wins; ties break toward the horizontal centre so
                # a bystander at the frame edge never beats the subject.
                ranked = sorted(
                    found,
                    key=lambda b: (-int(b[2]) * int(b[3]), abs((b[0] + b[2] / 2) - gray.shape[1] / 2)),
                )
                x, y, w, h = (int(v) for v in ranked[0])
                return x, y, w, h
    except Exception:
        return None
    return None


def head_crop_box(
    size: tuple[int, int], face: tuple[int, int, int, int] | None
) -> tuple[tuple[int, int, int, int], str]:
    """Square crop box for a head-and-shoulders portrait.

    Returns ``((left, top, right, bottom), mode)`` where mode is ``"face"`` or
    ``"fallback"``.  The square is always fully inside the image.
    """
    width, height = size
    if face is not None:
        x, y, w, h = face
        above = HEADROOM_ABOVE * h
        below = ROOM_BELOW * h
        wanted = h + above + below
        side = min(wanted, width, height)
        # When the image is too small for the ideal square, shrink the reserved
        # headroom/shoulder-room by the same factor rather than dropping one of
        # them -- that keeps the face in the same relative position.
        scale = side / wanted if wanted else 1.0
        left = (x + w / 2.0) - side / 2.0
        top = y - above * scale
        mode = "face"
    else:
        side = min(width, height * FALLBACK_HEIGHT_FRACTION, height)
        left = (width - side) / 2.0
        top = height * FALLBACK_TOP_FRACTION
        mode = "fallback"
    left = max(0.0, min(left, width - side))
    top = max(0.0, min(top, height - side))
    box = (
        int(round(left)),
        int(round(top)),
        int(round(left + side)),
        int(round(top + side)),
    )
    return box, mode


def render_face(image: Image.Image, size: int = OUTPUT_SIZE) -> tuple[Image.Image, str, tuple[int, int, int, int] | None]:
    """Crop + resize one portrait to a square face. Returns (image, mode, face_box)."""
    rgb = image.convert("RGB")
    face = detect_face(rgb)
    box, mode = head_crop_box(rgb.size, face)
    out = rgb.crop(box).resize((size, size), Image.LANCZOS)
    return out, mode, face


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


@dataclass
class FaceEntry:
    """One processed face: who, where it came from, under what licence."""

    key: str
    name: str
    branch: str            # "congress" | "executive"
    file: str
    source_url: str
    source_page: str | None
    licence: str
    attribution: str | None
    crop_mode: str
    bytes: int
    sha256: str
    bioguide: str | None = None
    filer_ids: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "key": self.key,
            "name": self.name,
            "branch": self.branch,
            "bioguide": self.bioguide,
            "filerIds": self.filer_ids,
            "file": self.file,
            "sourceUrl": self.source_url,
            "sourcePage": self.source_page,
            "licence": self.licence,
            "attribution": self.attribution,
            "cropMode": self.crop_mode,
            "bytes": self.bytes,
            "sha256": self.sha256,
        }


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_manifest(entries: Iterable[FaceEntry], path: Path = MANIFEST_PATH) -> dict:
    ordered = sorted(entries, key=lambda e: e.key)
    payload = {
        "version": 1,
        "note": (
            "Head-focused member portraits. Every entry records its original source "
            "URL and licence; only public-domain originals are shipped. Regenerate "
            "with scripts/member-photos/build_face_pack.py."
        ),
        "outputSize": OUTPUT_SIZE,
        "count": len(ordered),
        "totalBytes": sum(e.bytes for e in ordered),
        "faces": [e.to_json() for e in ordered],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    return payload


def load_manifest(path: Path = MANIFEST_PATH) -> dict:
    if not path.exists():
        return {"version": 1, "faces": []}
    return json.loads(path.read_text(encoding="utf-8"))
