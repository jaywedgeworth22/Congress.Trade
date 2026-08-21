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


if __name__ == "__main__":
    unittest.main()
