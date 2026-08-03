"""House PTR schedule grid lattice + per-cell checkbox marks.

Port of the proven projection approach from /tmp/scan_extract/analyze3.py and
grid_detect.py, using OpenCV/numpy for server (Linux ARM64) execution.

Column template (upright landscape schedule after 90° rotate of paper forms):
  type: P, S, E, CG, PS
  dates: TD, ND
  amount: A..K
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

from checkbox import ink_ratio

# Calibrated vertical line x-positions on a ~1650-wide upright schedule page.
# These are seeds; runtime detection snaps them.
TEMPLATE_X = [
    443, 497, 544, 603, 662, 720, 786, 867, 911, 952, 1001, 1049,
    1098, 1155, 1212, 1276, 1339, 1401, 1465,
]
COLNAMES = [
    "P", "S", "E", "CG", "PS", "TD", "ND",
    "A", "B", "C", "D", "E$", "F", "G", "H", "I", "J", "K",
]

# Printed amount ranges for House PTR brackets
BRACKET_RANGES: Dict[str, Tuple[int, Optional[int]]] = {
    "A": (1001, 15000),
    "B": (15001, 50000),
    "C": (50001, 100000),
    "D": (100001, 250000),
    "E": (250001, 500000),
    "F": (500001, 1000000),
    "G": (1000001, 5000000),
    "H": (5000001, 25000000),
    "I": (25000001, 50000000),
    "J": (50000000, None),
    "K": (1000000, None),  # Spouse/DC over $1M special
}


@dataclass
class GridRow:
    y0: int
    y1: int
    marks: Dict[str, float] = field(default_factory=dict)  # col → ink_ratio if checked
    is_data: bool = False


@dataclass
class GridPage:
    cols: List[int]
    rows: List[GridRow]
    page_w: int
    page_h: int


def _scale_template(w: int, base_w: int = 1650) -> List[int]:
    s = w / base_w
    return [int(round(x * s)) for x in TEMPLATE_X]


def _vline_candidates(gray: np.ndarray, vy0: float = 0.18, vy1: float = 0.90,
                      vx0: float = 0.25, vx1: float = 0.95) -> List[int]:
    h, w = gray.shape[:2]
    y0, y1 = int(h * vy0), int(h * vy1)
    x0, x1 = int(w * vx0), int(w * vx1)
    strip = gray[y0:y1, x0:x1]
    # dark coverage per x
    dark = (strip < 128).astype(np.float32)
    cov = dark.mean(axis=0)
    thr = 0.45
    raw = np.where(cov >= thr)[0] + x0
    if raw.size == 0:
        return []
    groups: List[List[int]] = []
    for x in raw.tolist():
        if groups and x - groups[-1][-1] <= 3:
            groups[-1].append(x)
        else:
            groups.append([x])
    return [int(sum(g) / len(g)) for g in groups]


def _row_lattice(gray: np.ndarray, y_lo_frac: float = 0.16, y_hi_frac: float = 0.92,
                 hx0_frac: float = 0.55, hx1_frac: float = 0.92) -> List[int]:
    h, w = gray.shape[:2]
    y_lo, y_hi = int(h * y_lo_frac), int(h * y_hi_frac)
    hx0, hx1 = int(w * hx0_frac), int(w * hx1_frac)
    strip = gray[y_lo:y_hi, hx0:hx1]
    dark = (strip < 128).astype(np.float32)
    proj = dark.mean(axis=1)
    thr = 0.28
    raw = np.where(proj >= thr)[0] + y_lo
    if raw.size == 0:
        return []
    groups: List[List[int]] = []
    for y in raw.tolist():
        if groups and y - groups[-1][-1] <= 2:
            groups[-1].append(y)
        else:
            groups.append([y])
    seeds = [int(sum(g) / len(g)) for g in groups]
    # pitch
    diffs = [b - a for a, b in zip(seeds, seeds[1:]) if 8 <= b - a <= 40]
    if not diffs:
        return seeds
    pitch = float(sorted(diffs)[len(diffs) // 2])
    # walk lattice
    out = [seeds[0]]
    y = seeds[0] + pitch
    while y < y_hi - 4:
        # snap to nearest seed within 4px
        best = None
        for s in seeds:
            if abs(s - y) <= 4 and (best is None or abs(s - y) < abs(best - y)):
                best = s
        out.append(int(best if best is not None else round(y)))
        y = out[-1] + pitch
    # unique increasing
    cleaned: List[int] = []
    for v in out:
        if not cleaned or v - cleaned[-1] >= 7:
            cleaned.append(v)
    return cleaned


def _fit_columns(detected: List[int], template: List[int]) -> List[int]:
    diffs = []
    for t in template:
        for d in detected:
            if abs(d - t) <= 12:
                diffs.append(d - t)
    diffs.sort()
    off = diffs[len(diffs) // 2] if diffs else 0
    cols = []
    for t in template:
        target = t + off
        best = None
        for d in detected:
            if abs(d - target) <= 10 and (best is None or abs(d - target) < abs(best - target)):
                best = d
        cols.append(best if best is not None else target)
    return cols


def analyze_grid(
    image_bgr: np.ndarray,
    *,
    ink_thr: float = 0.10,
    border_inset: int = 3,
) -> GridPage:
    """Detect lattice and classify checkbox cells on one upright schedule page."""
    if image_bgr.ndim == 3:
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    else:
        gray = image_bgr
    h, w = gray.shape[:2]
    template = _scale_template(w)
    det = _vline_candidates(gray)
    cols = _fit_columns(det, template) if det else template
    # ensure len(cols) == len(COLNAMES)+1? TEMPLATE has N points for N-1? 
    # TEMPLATE_X has 19 points for 18 columns (COLNAMES has 18). Yes.
    if len(cols) < len(COLNAMES) + 1:
        # pad from template
        while len(cols) < len(COLNAMES) + 1:
            cols.append(cols[-1] + 40 if cols else 400)

    lattice = _row_lattice(gray)
    rows: List[GridRow] = []
    for i in range(len(lattice) - 1):
        y0, y1 = lattice[i], lattice[i + 1]
        if y1 - y0 < 7:
            continue
        marks: Dict[str, float] = {}
        # date-column ink to decide if data row
        td_i = COLNAMES.index("TD")
        nd_i = COLNAMES.index("ND")
        td_cell = gray[y0:y1, cols[td_i] : cols[td_i + 1]]
        nd_cell = gray[y0:y1, cols[nd_i] : cols[nd_i + 1]]
        td_ink = float((td_cell < 128).mean()) if td_cell.size else 0.0
        nd_ink = float((nd_cell < 128).mean()) if nd_cell.size else 0.0
        is_data = td_ink >= 0.04 and nd_ink >= 0.04

        if is_data:
            for ci, name in enumerate(COLNAMES):
                if name in ("TD", "ND"):
                    continue
                x0, x1 = cols[ci], cols[ci + 1]
                if x1 <= x0 + 4:
                    continue
                cell = image_bgr[y0:y1, x0:x1]
                res = ink_ratio(cell, border_inset=border_inset, thr=ink_thr)
                if res.checked:
                    marks[name] = res.ink_ratio
        rows.append(GridRow(y0=y0, y1=y1, marks=marks, is_data=is_data))

    return GridPage(cols=cols, rows=rows, page_w=w, page_h=h)


def row_type(marks: Dict[str, float]) -> Optional[str]:
    """Map type checkboxes to P/S/E. Prefer highest ink among P/S/E."""
    candidates = {k: marks[k] for k in ("P", "S", "E") if k in marks}
    if not candidates:
        return None
    best = max(candidates, key=candidates.get)
    return best  # already P/S/E


def row_bracket(marks: Dict[str, float]) -> Optional[str]:
    """Map amount checkboxes; E$ column is amount E (letter)."""
    amt_keys = []
    for k, v in marks.items():
        if k in BRACKET_RANGES or k == "E$":
            amt_keys.append((k if k != "E$" else "E", v))
    if not amt_keys:
        return None
    best = max(amt_keys, key=lambda kv: kv[1])[0]
    return best
