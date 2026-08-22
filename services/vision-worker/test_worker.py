#!/usr/bin/env python3
"""Unit tests for vision-worker cascade helpers. No network."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import worker  # noqa: E402


WAGNER_PTR = {
    "transactions": [
        {
            "owner": "joint",
            "asset": "Dallas TX ISD 5% 2/15/2031",
            "ticker": None,
            "txType": "P",
            "txDate": "2025-01-21",
            "notifDate": "2025-01-22",
            "amountMin": 100001,
            "amountMax": 250000,
            "bracket": "D",
            "note": None,
        },
        {
            "owner": "joint",
            "asset": "Pecos Barstow Toyah TX 4% 2/15/2030",
            "ticker": None,
            "txType": "P",
            "txDate": "2025-01-21",
            "notifDate": "2025-01-22",
            "amountMin": 100001,
            "amountMax": 250000,
            "bracket": "D",
            "note": "first word on the scan can read as Pecis",
        },
    ]
}


class CascadeHelpersTest(unittest.TestCase):
    def test_default_cascade_is_qwen_then_gemini_then_grok(self):
        previous = worker.OPENROUTER_CASCADE_MODELS
        previous_model = worker.OPENROUTER_MODEL
        try:
            worker.OPENROUTER_CASCADE_MODELS = worker.DEFAULT_CASCADE_MODELS
            worker.OPENROUTER_MODEL = "x-ai/grok-4.5"
            models = worker.cascade_model_list()
            self.assertEqual(models[0], "qwen/qwen3-vl-8b-instruct")
            self.assertEqual(models[1], "qwen/qwen3-vl-30b-a3b-instruct")
            self.assertIn("google/gemini-3.7-flash", models)
            self.assertEqual(models[-1], "x-ai/grok-4.5")
            self.assertEqual(len(models), len(set(models)))
        finally:
            worker.OPENROUTER_CASCADE_MODELS = previous
            worker.OPENROUTER_MODEL = previous_model

    def test_cascade_env_override_dedupes_and_appends_grok(self):
        previous = worker.OPENROUTER_CASCADE_MODELS
        try:
            worker.OPENROUTER_CASCADE_MODELS = "qwen/qwen3-vl-8b-instruct, x-ai/grok-4.5, qwen/qwen3-vl-8b-instruct"
            models = worker.cascade_model_list()
            self.assertEqual(models, ["qwen/qwen3-vl-8b-instruct", "x-ai/grok-4.5"])
        finally:
            worker.OPENROUTER_CASCADE_MODELS = previous

    def test_qwen_uses_page_images_grok_and_gemini_do_not(self):
        self.assertTrue(worker.model_uses_page_images("qwen/qwen3-vl-8b-instruct"))
        self.assertTrue(worker.model_uses_page_images("qwen/qwen3-vl-30b-a3b-instruct"))
        self.assertFalse(worker.model_uses_page_images("x-ai/grok-4.5"))
        self.assertFalse(worker.model_uses_page_images("google/gemini-3.7-flash"))

    def test_truncated_qwen_hit_is_not_terminal(self):
        # 10-page PTR, Qwen only receives OPENROUTER_CASCADE_MAX_PAGES (8).
        # Accepting that hit would publish at 0.97 and lock pages 9-10 out.
        self.assertFalse(
            worker.cascade_hit_is_terminal("qwen/qwen3-vl-8b-instruct", 10, 10),
        )
        self.assertFalse(
            worker.cascade_hit_is_terminal("qwen/qwen3-vl-8b-instruct", 20, 12),
        )
        self.assertTrue(
            worker.cascade_hit_is_terminal("qwen/qwen3-vl-8b-instruct", 2, 2),
        )
        self.assertTrue(
            worker.cascade_hit_is_terminal("qwen/qwen3-vl-8b-instruct", 8, 8),
        )
        self.assertTrue(
            worker.cascade_hit_is_terminal("google/gemini-3.7-flash", 20, 12),
        )
        self.assertTrue(
            worker.cascade_hit_is_terminal("x-ai/grok-4.5", 20, 12),
        )

    def test_extractor_label_is_stable(self):
        self.assertEqual(
            worker.extractor_label_for_model("qwen/qwen3-vl-8b-instruct"),
            "openrouter_qwen_qwen3_vl_8b_instruct",
        )


class TruncatedCascadeTest(unittest.TestCase):
    def test_transcribe_continues_past_truncated_qwen_to_pdf_native(self):
        previous_key = worker.OPENROUTER_API_KEY
        previous_engine = worker.VISION_ENGINE
        previous_cascade = worker.OPENROUTER_CASCADE_MODELS
        previous_model = worker.OPENROUTER_MODEL
        called: list[str] = []

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            if worker.model_uses_page_images(model):
                return [{"assetName": "Dallas TX ISD 5% 2/15/2031", "txType": "P"}]
            if "gemini" in model:
                return [
                    {"assetName": "Dallas TX ISD 5% 2/15/2031", "txType": "P"},
                    {"assetName": "page-10 bond", "txType": "P"},
                ]
            return None

        worker.OPENROUTER_API_KEY = "test-key"
        worker.VISION_ENGINE = "openrouter"
        worker.OPENROUTER_CASCADE_MODELS = worker.DEFAULT_CASCADE_MODELS
        worker.OPENROUTER_MODEL = "x-ai/grok-4.5"
        original = worker.transcribe_with_openrouter
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                [f"/tmp/page-{i}.png" for i in range(10)],
                {"doc_id": "wagner-long", "chamber": "house", "filed_date": "2025-02-14"},
                "/tmp",
                total_pages=10,
            )
        finally:
            worker.transcribe_with_openrouter = original
            worker.OPENROUTER_API_KEY = previous_key
            worker.VISION_ENGINE = previous_engine
            worker.OPENROUTER_CASCADE_MODELS = previous_cascade
            worker.OPENROUTER_MODEL = previous_model

        self.assertEqual(called[0], "qwen/qwen3-vl-8b-instruct")
        self.assertEqual(called[1], "qwen/qwen3-vl-30b-a3b-instruct")
        self.assertIn("google/gemini-3.7-flash", called)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["assetName"], "page-10 bond")
        self.assertEqual(label, worker.extractor_label_for_model("google/gemini-3.7-flash"))

    def test_short_qwen_hit_stays_terminal(self):
        previous_key = worker.OPENROUTER_API_KEY
        previous_engine = worker.VISION_ENGINE
        previous_cascade = worker.OPENROUTER_CASCADE_MODELS
        called: list[str] = []

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            return [{"assetName": "Dallas TX ISD 5% 2/15/2031", "txType": "P"}]

        worker.OPENROUTER_API_KEY = "test-key"
        worker.VISION_ENGINE = "openrouter"
        worker.OPENROUTER_CASCADE_MODELS = worker.DEFAULT_CASCADE_MODELS
        original = worker.transcribe_with_openrouter
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                ["/tmp/page-1.png", "/tmp/page-2.png"],
                {"doc_id": "wagner-short", "chamber": "house"},
                "/tmp",
                total_pages=2,
            )
        finally:
            worker.transcribe_with_openrouter = original
            worker.OPENROUTER_API_KEY = previous_key
            worker.VISION_ENGINE = previous_engine
            worker.OPENROUTER_CASCADE_MODELS = previous_cascade

        self.assertEqual(called, ["qwen/qwen3-vl-8b-instruct"])
        self.assertEqual(len(rows), 1)
        self.assertEqual(label, worker.extractor_label_for_model("qwen/qwen3-vl-8b-instruct"))


class TruncatedLocalCliTest(unittest.TestCase):
    def test_truncated_local_cli_continues_to_pdf_native(self):
        previous_key = worker.OPENROUTER_API_KEY
        previous_engine = worker.VISION_ENGINE
        previous_cascade = worker.OPENROUTER_CASCADE_MODELS
        previous_model = worker.OPENROUTER_MODEL
        called: list[str] = []

        def fake_cli(_pages, _filing):
            return [{"assetName": "page-1 stock", "txType": "P"}]

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            if worker.model_uses_page_images(model):
                return [{"assetName": "should-not-run", "txType": "P"}]
            return [
                {"assetName": "page-1 stock", "txType": "P"},
                {"assetName": "page-20 stock", "txType": "P"},
            ]

        worker.OPENROUTER_API_KEY = "test-key"
        worker.VISION_ENGINE = "auto"
        worker.OPENROUTER_CASCADE_MODELS = worker.DEFAULT_CASCADE_MODELS
        worker.OPENROUTER_MODEL = "x-ai/grok-4.5"
        original_cli = worker.transcribe_with_local_cli
        original_or = worker.transcribe_with_openrouter
        worker.transcribe_with_local_cli = fake_cli
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                [f"/tmp/page-{i}.png" for i in range(12)],
                {"doc_id": "long-ptr", "chamber": "house", "filed_date": "2025-02-14"},
                "/tmp",
                total_pages=20,
            )
        finally:
            worker.transcribe_with_local_cli = original_cli
            worker.transcribe_with_openrouter = original_or
            worker.OPENROUTER_API_KEY = previous_key
            worker.VISION_ENGINE = previous_engine
            worker.OPENROUTER_CASCADE_MODELS = previous_cascade
            worker.OPENROUTER_MODEL = previous_model

        self.assertEqual(called[0], "google/gemini-3.7-flash")
        self.assertNotIn("qwen/qwen3-vl-8b-instruct", called)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["assetName"], "page-20 stock")
        self.assertEqual(label, worker.extractor_label_for_model("google/gemini-3.7-flash"))

    def test_complete_local_cli_stays_terminal(self):
        previous_key = worker.OPENROUTER_API_KEY
        previous_engine = worker.VISION_ENGINE
        called: list[str] = []

        def fake_cli(_pages, _filing):
            return [{"assetName": "Dallas TX ISD 5% 2/15/2031", "txType": "P"}]

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            return [{"assetName": "should-not-run", "txType": "P"}]

        worker.OPENROUTER_API_KEY = "test-key"
        worker.VISION_ENGINE = "auto"
        original_cli = worker.transcribe_with_local_cli
        original_or = worker.transcribe_with_openrouter
        worker.transcribe_with_local_cli = fake_cli
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                [f"/tmp/page-{i}.png" for i in range(8)],
                {"doc_id": "short-ptr", "chamber": "house"},
                "/tmp",
                total_pages=8,
            )
        finally:
            worker.transcribe_with_local_cli = original_cli
            worker.transcribe_with_openrouter = original_or
            worker.OPENROUTER_API_KEY = previous_key
            worker.VISION_ENGINE = previous_engine

        self.assertEqual(called, [])
        self.assertEqual(len(rows), 1)
        self.assertEqual(label, "local_grok_cli_v1")

    def test_local_cli_engine_keeps_truncated_hit(self):
        previous_engine = worker.VISION_ENGINE
        called: list[str] = []

        def fake_cli(_pages, _filing):
            return [{"assetName": "page-1 stock", "txType": "P"}]

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            return [{"assetName": "should-not-run", "txType": "P"}]

        worker.VISION_ENGINE = "local_cli"
        original_cli = worker.transcribe_with_local_cli
        original_or = worker.transcribe_with_openrouter
        worker.transcribe_with_local_cli = fake_cli
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                [f"/tmp/page-{i}.png" for i in range(12)],
                {"doc_id": "local-only", "chamber": "house"},
                "/tmp",
                total_pages=20,
            )
        finally:
            worker.transcribe_with_local_cli = original_cli
            worker.transcribe_with_openrouter = original_or
            worker.VISION_ENGINE = previous_engine

        self.assertEqual(called, [])
        self.assertEqual(len(rows), 1)
        self.assertEqual(label, "local_grok_cli_v1")

    def test_auto_skips_local_cli_when_over_max_pages(self):
        previous_key = worker.OPENROUTER_API_KEY
        previous_engine = worker.VISION_ENGINE
        previous_cascade = worker.OPENROUTER_CASCADE_MODELS
        previous_model = worker.OPENROUTER_MODEL
        called: list[str] = []
        cli_called = {"n": 0}

        def fake_cli(_pages, _filing):
            cli_called["n"] += 1
            return [{"assetName": "should-not-run", "txType": "P"}]

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            if worker.model_uses_page_images(model):
                return [{"assetName": "qwen-truncated", "txType": "P"}]
            return [{"assetName": "page-20 stock", "txType": "P"}]

        worker.OPENROUTER_API_KEY = "test-key"
        worker.VISION_ENGINE = "auto"
        worker.OPENROUTER_CASCADE_MODELS = worker.DEFAULT_CASCADE_MODELS
        worker.OPENROUTER_MODEL = "x-ai/grok-4.5"
        original_cli = worker.transcribe_with_local_cli
        original_or = worker.transcribe_with_openrouter
        worker.transcribe_with_local_cli = fake_cli
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                [f"/tmp/page-{i}.png" for i in range(12)],
                {"doc_id": "khanna-24p", "chamber": "house"},
                "/tmp",
                total_pages=24,
            )
        finally:
            worker.transcribe_with_local_cli = original_cli
            worker.transcribe_with_openrouter = original_or
            worker.OPENROUTER_API_KEY = previous_key
            worker.VISION_ENGINE = previous_engine
            worker.OPENROUTER_CASCADE_MODELS = previous_cascade
            worker.OPENROUTER_MODEL = previous_model

        self.assertEqual(cli_called["n"], 0)
        self.assertEqual(called[0], "google/gemini-3.7-flash")
        self.assertNotIn("qwen/qwen3-vl-8b-instruct", called)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["assetName"], "page-20 stock")
        self.assertEqual(label, worker.extractor_label_for_model("google/gemini-3.7-flash"))

    def test_pdf_native_chunk_miss_is_not_terminal(self):
        calls = {"n": 0}

        def fake_split(_pdf, _work, _n):
            return ["/tmp/chunk-00.pdf", "/tmp/chunk-01.pdf", "/tmp/chunk-02.pdf"]

        def fake_one(_pdf, _pages, _filing, _model, _work, prompt_extra=""):
            calls["n"] += 1
            if calls["n"] == 2:
                return None
            return [{"assetName": f"chunk-{calls['n']} stock", "txType": "P"}]

        original_split = worker.split_pdf_chunks
        original_one = worker.transcribe_openrouter_one
        original_pdfinfo = worker.pdfinfo_pages
        worker.split_pdf_chunks = fake_split
        worker.transcribe_openrouter_one = fake_one
        worker.pdfinfo_pages = lambda _p: 10
        try:
            rows = worker.transcribe_pdf_native_chunked(
                "/tmp/filing.pdf",
                {"doc_id": "khanna-24p", "chamber": "house"},
                "google/gemini-3.7-flash",
                "/tmp",
                24,
            )
        finally:
            worker.split_pdf_chunks = original_split
            worker.transcribe_openrouter_one = original_one
            worker.pdfinfo_pages = original_pdfinfo

        self.assertIsNone(rows)
        self.assertEqual(calls["n"], 2)

    def test_pdf_native_empty_cover_chunk_still_merges(self):
        calls = {"n": 0}

        def fake_split(_pdf, _work, _n):
            return ["/tmp/chunk-00.pdf", "/tmp/chunk-01.pdf"]

        def fake_one(_pdf, _pages, _filing, _model, _work, prompt_extra=""):
            calls["n"] += 1
            if calls["n"] == 1:
                return []
            return [{"assetName": "page-20 stock", "txType": "P"}]

        original_split = worker.split_pdf_chunks
        original_one = worker.transcribe_openrouter_one
        original_pdfinfo = worker.pdfinfo_pages
        worker.split_pdf_chunks = fake_split
        worker.transcribe_openrouter_one = fake_one
        worker.pdfinfo_pages = lambda _p: 10
        try:
            rows = worker.transcribe_pdf_native_chunked(
                "/tmp/filing.pdf",
                {"doc_id": "khanna-cover", "chamber": "house"},
                "google/gemini-3.7-flash",
                "/tmp",
                20,
            )
        finally:
            worker.split_pdf_chunks = original_split
            worker.transcribe_openrouter_one = original_one
            worker.pdfinfo_pages = original_pdfinfo

        self.assertIsNotNone(rows)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["assetName"], "page-20 stock")
        self.assertEqual(calls["n"], 2)


class ParseAndValidateTest(unittest.TestCase):
    def test_wagner_ptr_gold_two_joint_muni_purchases(self):
        blob = json.dumps(WAGNER_PTR)
        parsed = worker.parse_model_json("Here you go\n" + blob)
        rows = worker.rows_from_parsed(parsed)
        self.assertIsNotNone(rows)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["assetName"], "Dallas TX ISD 5% 2/15/2031")
        self.assertEqual(rows[0]["txType"], "P")
        self.assertEqual(rows[0]["owner"], "joint")
        self.assertEqual(rows[0]["amountMin"], 100001)
        self.assertEqual(rows[0]["amountMax"], 250000)
        self.assertEqual(rows[1]["assetName"], "Pecos Barstow Toyah TX 4% 2/15/2030")
        self.assertEqual(rows[1]["txDate"], "2025-01-21")
        self.assertEqual(rows[1]["description"], "first word on the scan can read as Pecis")

    def test_zero_rows_without_norows_is_a_miss(self):
        miss = worker.rows_or_miss({"transactions": []}, "test")
        self.assertIsNone(miss)
        empty = worker.rows_or_miss({"transactions": [], "noRows": True}, "test")
        self.assertEqual(empty, [])

    def test_openrouter_qwen_content_is_images_not_pdf(self):
        with tempfile.TemporaryDirectory() as td:
            page = os.path.join(td, "page-1.png")
            import struct
            import zlib

            def png_chunk(tag: bytes, data: bytes) -> bytes:
                crc = zlib.crc32(tag + data) & 0xFFFFFFFF
                return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

            raw = b"\x00\x00\x00\x00"
            Path(page).write_bytes(
                b"\x89PNG\r\n\x1a\n"
                + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
                + png_chunk(b"IDAT", zlib.compress(raw))
                + png_chunk(b"IEND", b"")
            )
            parts = worker.openrouter_user_content(
                "transcribe",
                os.path.join(td, "missing.pdf"),
                [page],
                "qwen/qwen3-vl-8b-instruct",
                td,
            )
            self.assertIsNotNone(parts)
            kinds = [p.get("type") for p in parts]
            self.assertIn("image_url", kinds)
            self.assertNotIn("file", kinds)
            self.assertEqual(parts[-1]["type"], "text")


class UprightRotateTest(unittest.TestCase):
    def _png(self, path: str, width: int, height: int) -> str:
        from PIL import Image
        Image.new("RGB", (width, height), (240, 240, 240)).save(path)
        return path

    def test_landscape_page_stays_unrotated(self):
        with tempfile.TemporaryDirectory() as td:
            page = self._png(os.path.join(td, "page-1.png"), 40, 20)
            self.assertEqual(worker.choose_upright_cw_degrees(page, score_fn=lambda _p: 9), 0)

    def test_portrait_prefers_the_higher_tesseract_score(self):
        with tempfile.TemporaryDirectory() as td:
            page = self._png(os.path.join(td, "page-1.png"), 20, 40)

            def score(path: str) -> int:
                return 5 if path.endswith(".rot90.png") else 1

            self.assertEqual(worker.choose_upright_cw_degrees(page, score_fn=score), 90)

    def test_portrait_defaults_to_270_when_ocr_is_silent(self):
        with tempfile.TemporaryDirectory() as td:
            page = self._png(os.path.join(td, "page-1.png"), 20, 40)
            self.assertEqual(worker.choose_upright_cw_degrees(page, score_fn=lambda _p: 0), 270)

    def test_upright_pages_rotates_every_page_the_same_way(self):
        with tempfile.TemporaryDirectory() as td:
            pages = [
                self._png(os.path.join(td, "page-1.png"), 20, 40),
                self._png(os.path.join(td, "page-2.png"), 20, 40),
            ]
            worker.upright_pages(pages, score_fn=lambda _p: 0)
            from PIL import Image
            for path in pages:
                with Image.open(path) as im:
                    self.assertEqual(im.size, (40, 20))


if __name__ == "__main__":
    unittest.main()
