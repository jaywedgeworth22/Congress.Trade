"""Deterministic checkbox classification via ink pixel ratio.

No LLM. Align is optional; for PTR schedule pages we rely on grid projection
to get cell ROIs, then:

  crop → inset border → binarize → morphological open → ink_ratio

Checked when dark_pixels / interior_pixels >= threshold (default 0.10).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np


@dataclass
class CheckboxResult:
    checked: bool
    ink_ratio: float
    dark_pixels: int
    interior_pixels: int
    thr: float


def binarize(gray: np.ndarray) -> np.ndarray:
    """Adaptive/Otsu hybrid: Otsu when contrast ok, else fixed 128."""
    if gray.ndim == 3:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    # light blur to stabilize threshold
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    # Otsu
    _, otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return otsu


def denoise_binary(bin_inv: np.ndarray) -> np.ndarray:
    """Morphological opening removes 1-pixel speckles without erasing X strokes."""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2))
    return cv2.morphologyEx(bin_inv, cv2.MORPH_OPEN, kernel, iterations=1)


def ink_ratio(
    gray_cell: np.ndarray,
    *,
    border_inset: int = 3,
    thr: float = 0.10,
) -> CheckboxResult:
    """Return whether the interior of a checkbox cell is marked.

    gray_cell: cropped cell image (BGR or gray).
    border_inset: pixels stripped from each edge so printed box lines are ignored.
    thr: dark-pixel fraction of interior that means "checked".
    """
    if gray_cell is None or gray_cell.size == 0:
        return CheckboxResult(False, 0.0, 0, 0, thr)

    if gray_cell.ndim == 3:
        gray = cv2.cvtColor(gray_cell, cv2.COLOR_BGR2GRAY)
    else:
        gray = gray_cell

    h, w = gray.shape[:2]
    bi = max(1, min(border_inset, h // 4, w // 4))
    interior = gray[bi : h - bi, bi : w - bi]
    if interior.size == 0:
        return CheckboxResult(False, 0.0, 0, 0, thr)

    bin_inv = denoise_binary(binarize(interior))
    # bin_inv: 255 = dark (ink), 0 = light
    dark = int(np.count_nonzero(bin_inv > 0))
    total = int(interior.size)
    ratio = dark / total if total else 0.0
    return CheckboxResult(
        checked=ratio >= thr,
        ink_ratio=ratio,
        dark_pixels=dark,
        interior_pixels=total,
        thr=thr,
    )


def is_checked(
    gray_cell: np.ndarray,
    *,
    border_inset: int = 3,
    thr: float = 0.10,
) -> bool:
    return ink_ratio(gray_cell, border_inset=border_inset, thr=thr).checked


def align_to_template(
    query_bgr: np.ndarray,
    template_bgr: np.ndarray,
) -> Tuple[np.ndarray, Optional[np.ndarray]]:
    """Homography-align query to template via ORB features.

    Returns (warped_query, H) or (query, None) if match is weak.
    """
    q = cv2.cvtColor(query_bgr, cv2.COLOR_BGR2GRAY)
    t = cv2.cvtColor(template_bgr, cv2.COLOR_BGR2GRAY)
    orb = cv2.ORB_create(2000)
    kq, dq = orb.detectAndCompute(q, None)
    kt, dt = orb.detectAndCompute(t, None)
    if dq is None or dt is None or len(kq) < 12 or len(kt) < 12:
        return query_bgr, None
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = sorted(bf.match(dq, dt), key=lambda m: m.distance)[:80]
    if len(matches) < 12:
        return query_bgr, None
    src = np.float32([kq[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
    dst = np.float32([kt[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    if H is None:
        return query_bgr, None
    h, w = t.shape[:2]
    warped = cv2.warpPerspective(query_bgr, H, (w, h))
    return warped, H
