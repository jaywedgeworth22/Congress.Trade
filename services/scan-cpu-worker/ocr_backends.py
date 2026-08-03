"""CPU-only OCR backends for scanned PTR pages.

Default: Tesseract (system binary + pytesseract).
Optional: Surya, docTR — enabled only when OCR_BACKEND env selects them and
packages are installed (see requirements-optional.txt).
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import List, Optional, Protocol

import numpy as np

logger = logging.getLogger("scan-cpu-worker.ocr")


@dataclass
class OcrLine:
    text: str
    conf: float
    # normalized bbox origin top-left: x, y, w, h in [0,1] when available
    bbox: Optional[List[float]] = None


@dataclass
class OcrPage:
    lines: List[OcrLine] = field(default_factory=list)
    full_text: str = ""
    backend: str = "tesseract"

    @property
    def mean_conf(self) -> float:
        if not self.lines:
            return 0.0
        return sum(l.conf for l in self.lines) / len(self.lines)


class OcrBackend(Protocol):
    name: str

    def run(self, image_bgr: np.ndarray) -> OcrPage: ...


class TesseractBackend:
    name = "tesseract"

    def __init__(self, psm: int = 6, lang: str = "eng"):
        self.psm = psm
        self.lang = lang

    def run(self, image_bgr: np.ndarray) -> OcrPage:
        import cv2
        import pytesseract
        from pytesseract import Output

        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY) if image_bgr.ndim == 3 else image_bgr
        h, w = gray.shape[:2]
        data = pytesseract.image_to_data(
            gray,
            lang=self.lang,
            config=f"--psm {self.psm}",
            output_type=Output.DICT,
        )
        lines: List[OcrLine] = []
        # group by (block, par, line)
        buckets: dict[tuple, list[int]] = {}
        n = len(data["text"])
        for i in range(n):
            txt = (data["text"][i] or "").strip()
            if not txt:
                continue
            key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
            buckets.setdefault(key, []).append(i)
        for key, idxs in buckets.items():
            words = [data["text"][i].strip() for i in idxs if data["text"][i].strip()]
            if not words:
                continue
            confs = []
            xs, ys, xe, ye = [], [], [], []
            for i in idxs:
                try:
                    confs.append(float(data["conf"][i]))
                except (TypeError, ValueError):
                    confs.append(0.0)
                xs.append(data["left"][i])
                ys.append(data["top"][i])
                xe.append(data["left"][i] + data["width"][i])
                ye.append(data["top"][i] + data["height"][i])
            conf = sum(c for c in confs if c >= 0) / max(1, sum(1 for c in confs if c >= 0))
            # normalize conf 0..1 (tesseract is -1..100)
            conf01 = max(0.0, min(1.0, conf / 100.0))
            x0, y0, x1, y1 = min(xs), min(ys), max(xe), max(ye)
            bbox = [x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h]
            lines.append(OcrLine(text=" ".join(words), conf=conf01, bbox=bbox))
        full = "\n".join(l.text for l in lines)
        return OcrPage(lines=lines, full_text=full, backend=self.name)


class SuryaBackend:
    """Optional. Lazy-imports surya; falls back to tesseract on ImportError."""

    name = "surya"

    def __init__(self):
        self._ready = False
        try:
            # Import only to probe; actual API varies by surya version.
            import surya  # noqa: F401

            self._ready = True
        except Exception as e:
            logger.warning("Surya unavailable (%s); use tesseract", e)
            self._fallback = TesseractBackend()

    def run(self, image_bgr: np.ndarray) -> OcrPage:
        if not self._ready:
            page = self._fallback.run(image_bgr)
            page.backend = "tesseract(fallback-from-surya)"
            return page
        # Best-effort: many surya installs expose recognition via CLI-style APIs.
        # Keep integration soft so core path never hard-depends on surya.
        try:
            from PIL import Image
            import cv2

            rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
            # Prefer a simple path if present; otherwise fall back.
            try:
                from surya.ocr import run_ocr  # type: ignore
                from surya.model.detection.model import load_model as load_det  # type: ignore
                from surya.model.recognition.model import load_model as load_rec  # type: ignore

                det = load_det()
                rec = load_rec()
                imgs = [Image.fromarray(rgb)]
                results = run_ocr(imgs, [["en"]], det, rec)
                lines: List[OcrLine] = []
                for page_res in results:
                    for tl in getattr(page_res, "text_lines", []) or []:
                        text = getattr(tl, "text", "") or ""
                        conf = float(getattr(tl, "confidence", 0.8) or 0.8)
                        lines.append(OcrLine(text=text, conf=conf))
                return OcrPage(
                    lines=lines,
                    full_text="\n".join(l.text for l in lines),
                    backend=self.name,
                )
            except Exception as inner:
                logger.warning("Surya run failed (%s); tesseract fallback", inner)
                page = TesseractBackend().run(image_bgr)
                page.backend = "tesseract(fallback-from-surya-run)"
                return page
        except Exception as e:
            logger.warning("Surya path error: %s", e)
            page = TesseractBackend().run(image_bgr)
            page.backend = "tesseract(fallback-from-surya)"
            return page


class DoctrBackend:
    name = "doctr"

    def __init__(self):
        self._predictor = None
        try:
            from doctr.models import ocr_predictor

            self._predictor = ocr_predictor(pretrained=True)
        except Exception as e:
            logger.warning("docTR unavailable (%s); use tesseract", e)
            self._fallback = TesseractBackend()

    def run(self, image_bgr: np.ndarray) -> OcrPage:
        if self._predictor is None:
            page = self._fallback.run(image_bgr)
            page.backend = "tesseract(fallback-from-doctr)"
            return page
        import cv2
        from doctr.io import DocumentFile

        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        # DocumentFile expects paths or raw bytes; encode PNG bytes.
        ok, buf = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        if not ok:
            page = TesseractBackend().run(image_bgr)
            page.backend = "tesseract(fallback-from-doctr-encode)"
            return page
        doc = DocumentFile.from_images([buf.tobytes()])
        result = self._predictor(doc)
        lines: List[OcrLine] = []
        # result.export() → nested pages/blocks/lines/words
        exported = result.export()
        for page in exported.get("pages", []):
            for block in page.get("blocks", []):
                for line in block.get("lines", []):
                    words = [w.get("value", "") for w in line.get("words", [])]
                    confs = [float(w.get("confidence", 0.8)) for w in line.get("words", [])]
                    text = " ".join(words).strip()
                    if not text:
                        continue
                    conf = sum(confs) / max(1, len(confs))
                    lines.append(OcrLine(text=text, conf=conf))
        return OcrPage(lines=lines, full_text="\n".join(l.text for l in lines), backend=self.name)


def get_backend(name: Optional[str] = None) -> OcrBackend:
    name = (name or os.getenv("OCR_BACKEND", "tesseract")).strip().lower()
    if name == "surya":
        return SuryaBackend()
    if name == "doctr":
        return DoctrBackend()
    return TesseractBackend()


DATE_RE = re.compile(r"\b(\d{1,2}/\d{1,2}/\d{2,4})\b")


def extract_dates(text: str) -> List[str]:
    return DATE_RE.findall(text or "")
