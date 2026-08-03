"""Unit tests for deterministic checkbox ink-ratio (no LLM, no network)."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from checkbox import ink_ratio, is_checked  # noqa: E402


def _blank_box(size: int = 40) -> np.ndarray:
    """White square with a thin dark border (empty checkbox look)."""
    img = np.full((size, size), 255, dtype=np.uint8)
    img[0, :] = 0
    img[-1, :] = 0
    img[:, 0] = 0
    img[:, -1] = 0
    return img


def _x_mark_box(size: int = 40) -> np.ndarray:
    img = _blank_box(size)
    # filled blob / thick X in interior (simulates a pen X or filled mark)
    for i in range(6, size - 6):
        for t in range(-2, 3):
            r1, c1 = i, min(size - 1, max(0, i + t))
            r2, c2 = i, min(size - 1, max(0, size - 1 - i + t))
            img[r1, c1] = 0
            img[r2, c2] = 0
            if 0 <= i + t < size:
                img[i + t, i] = 0
                img[i + t, size - 1 - i] = 0
    return img


def test_empty_checkbox_not_checked():
    res = ink_ratio(_blank_box(), border_inset=3, thr=0.10)
    assert res.checked is False
    assert res.ink_ratio < 0.10


def test_x_mark_is_checked():
    res = ink_ratio(_x_mark_box(), border_inset=3, thr=0.10)
    assert res.checked is True
    assert res.ink_ratio >= 0.10


def test_is_checked_helper():
    assert is_checked(_blank_box()) is False
    assert is_checked(_x_mark_box()) is True


def test_empty_input():
    res = ink_ratio(np.array([]), thr=0.10)
    assert res.checked is False
