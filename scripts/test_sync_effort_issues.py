from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("sync-effort-issues.py")
SPEC = importlib.util.spec_from_file_location("sync_effort_issues", SCRIPT_PATH)
assert SPEC and SPEC.loader
sync = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sync
SPEC.loader.exec_module(sync)


class ClassifyHeadingTests(unittest.TestCase):
    def test_active_and_in_progress_stay_open(self) -> None:
        self.assertEqual(sync.classify_heading("Active / In Progress"), "in-progress")
        self.assertEqual(sync.classify_heading("In Progress"), "in-progress")

    def test_closed_and_archive_beat_in_progress_substring(self) -> None:
        # Regression: prior keyword order treated these as live in-progress and
        # re-opened ~100 finished effort-board GitHub Issues after cleanup.
        self.assertEqual(
            sync.classify_heading(
                "Recently closed (were stale OPEN/IN PROGRESS — verified merged on main)"
            ),
            "completed",
        )
        self.assertEqual(sync.classify_heading("Recently completed"), "completed")
        self.assertEqual(
            sync.classify_heading("Historical archive (closed — chronology only)"),
            "completed",
        )
        self.assertEqual(sync.classify_heading("Completed"), "completed")
        self.assertEqual(sync.classify_heading("Deployed"), "deployed")

    def test_planned_and_ignored(self) -> None:
        self.assertEqual(sync.classify_heading("Planned / Reserved"), "planned")
        self.assertIsNone(sync.classify_heading("Changelog of this log"))


class ParseBoardBucketTests(unittest.TestCase):
    def test_recently_closed_heading_does_not_open_rows(self) -> None:
        rows = sync.parse_board(
            "## Active / In Progress\n"
            "- Live CODEX ops row\n"
            "## Recently closed (were stale OPEN/IN PROGRESS)\n"
            "- MERGED PR #862 terra/luna hotfix\n"
            "## Historical archive (closed)\n"
            "- Old CLAUDE In Progress PR #620\n"
            "## Planned / Reserved\n"
            "- Owner decision: analytics premium-only?\n"
        )
        by_bucket = {row.bucket: [r.first_line for r in rows if r.bucket == row.bucket] for row in rows}
        self.assertEqual(by_bucket["in-progress"], ["Live CODEX ops row"])
        self.assertEqual(
            sorted(r.first_line for r in rows if r.bucket == "completed"),
            [
                "MERGED PR #862 terra/luna hotfix",
                "Old CLAUDE In Progress PR #620",
            ],
        )
        self.assertEqual(by_bucket["planned"], ["Owner decision: analytics premium-only?"])


class OrphanRetirementTests(unittest.TestCase):
    def test_open_orphan_is_closed_and_labelled(self) -> None:
        current = sync.BoardItem("planned", "Current live planned row")
        orphan_key = "a" * 40
        orphan = {
            "number": 9,
            "title": "stale",
            "body": f"body\n<!-- effort-key: {orphan_key} -->",
            "state": "open",
            "labels": [{"name": sync.MIRROR_LABEL}, {"name": "state:planned"}],
        }
        live = {
            "number": 1,
            "title": current.title,
            "body": sync.build_body(current, "o/r", "sha"),
            "state": "open",
            "labels": [{"name": label} for label in sync.desired_labels("planned")],
        }

        class FakeClient:
            def __init__(self) -> None:
                self.issues = [live, orphan]
                self.updates: list[tuple[int, dict]] = []

            def list_all_issues(self):
                return self.issues

            def create_issue(self, *args, **kwargs):
                raise AssertionError("should not create")

            def update_issue(self, number: int, fields: dict) -> None:
                self.updates.append((number, fields))

        client = FakeClient()
        stats = sync.reconcile([current], client, "o/r", "sha", None)
        orphan_update = next(fields for number, fields in client.updates if number == 9)
        self.assertEqual(orphan_update["state"], "closed")
        self.assertIn(sync.ORPHANED_LABEL, orphan_update["labels"])
        self.assertEqual(stats["orphaned"], 1)


if __name__ == "__main__":
    unittest.main()
