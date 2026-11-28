#!/usr/bin/env python3
"""Unit tests for plugin download stats aggregation and package release sync planning."""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import stats  # noqa: E402


class StatsAndSyncPlanTests(unittest.TestCase):
    def test_plan_sync_handles_healthy_starter_empty_and_missing_archives(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dist_dir = pathlib.Path(tmp) / "dist"
            dist_dir.mkdir()

            normal_file = dist_dir / "clock-0.1.4.tar.gz"
            normal_file.write_bytes(b"A" * 120)

            starter_file = dist_dir / "browser-0.2.0.tar.gz"
            starter_file.write_bytes(b"B" * 240)

            truncated_file = dist_dir / "sqlite-0.1.1.tar.gz"
            truncated_file.write_bytes(b"C" * 300)

            missing_file = dist_dir / "agent-mesh-1.0.1.tar.gz"
            missing_file.write_bytes(b"D" * 450)

            assets = [
                # Healthy uploaded asset -> MUST be kept untouched so download_count stays intact.
                {
                    "id": 1001,
                    "name": "clock-0.1.4.tar.gz",
                    "state": "uploaded",
                    "size": 120,
                    "download_count": 42,
                },
                # Failed upload placeholder left in GitHub's "starter" state (empty) -> delete & re-upload.
                {
                    "id": 1002,
                    "name": "browser-0.2.0.tar.gz",
                    "state": "starter",
                    "size": 0,
                    "download_count": 0,
                },
                # Size mismatch / truncated upload -> delete & re-upload.
                {
                    "id": 1003,
                    "name": "sqlite-0.1.1.tar.gz",
                    "state": "uploaded",
                    "size": 64,
                    "download_count": 1,
                },
                # Historical release asset no longer in dist/ -> ignored safely.
                {
                    "id": 1004,
                    "name": "clock-0.1.3.tar.gz",
                    "state": "uploaded",
                    "size": 99,
                    "download_count": 15,
                },
                # Output file stats.json itself -> ignored safely.
                {
                    "id": 1005,
                    "name": "stats.json",
                    "state": "uploaded",
                    "size": 500,
                    "download_count": 99,
                },
            ]

            plan = stats.plan_package_sync(assets, dist_dir)
            self.assertEqual(plan["keep"], ["clock-0.1.4.tar.gz"])
            self.assertEqual(
                [(item["id"], item["name"], item["state"], item["size"]) for item in plan["delete"]],
                [
                    (1002, "browser-0.2.0.tar.gz", "starter", 0),
                    (1003, "sqlite-0.1.1.tar.gz", "uploaded", 64),
                ],
            )
            self.assertEqual(
                [pathlib.Path(p).name for p in plan["upload"]],
                [
                    "agent-mesh-1.0.1.tar.gz",
                    "browser-0.2.0.tar.gz",
                    "sqlite-0.1.1.tar.gz",
                ],
            )

    def test_plan_sync_keeps_healthy_duplicate_and_deletes_only_starter_duplicate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dist_dir = pathlib.Path(tmp) / "dist"
            dist_dir.mkdir()
            (dist_dir / "clock-0.1.4.tar.gz").write_bytes(b"X" * 50)

            assets = [
                {"id": 2001, "name": "clock-0.1.4.tar.gz", "state": "starter", "size": 0, "download_count": 0},
                {"id": 2002, "name": "clock-0.1.4.tar.gz", "state": "uploaded", "size": 50, "download_count": 17},
            ]
            plan = stats.plan_package_sync(assets, dist_dir)
            self.assertEqual(plan["keep"], ["clock-0.1.4.tar.gz"])
            self.assertEqual([item["id"] for item in plan["delete"]], [2001])
            self.assertEqual(plan["upload"], [])

    def test_load_assets_payload_parses_concatenated_paginated_arrays(self) -> None:
        raw = (
            json.dumps([{"id": 1, "name": "clock-0.1.4.tar.gz", "state": "uploaded", "size": 10}])
            + "\n"
            + json.dumps([{"id": 2, "name": "browser-0.2.0.tar.gz", "state": "starter", "size": 0}])
        )
        loaded = stats.load_assets_payload(raw)
        self.assertEqual([item["id"] for item in loaded], [1, 2])

    def test_aggregate_downloads_ignores_starter_and_aggregates_versions(self) -> None:
        known = ["documents-to-markdown", "clock", "browser"]
        assets = [
            {"name": "clock-0.1.3.tar.gz", "state": "uploaded", "download_count": 5},
            {"name": "clock-0.1.4.tar.gz", "state": "uploaded", "download_count": 10},
            {"name": "browser-0.2.0.tar.gz", "state": "starter", "download_count": 99},
            {"name": "documents-to-markdown-0.1.0-win32-x64.tar.gz", "download_count": 3},
        ]
        self.assertEqual(
            stats.aggregate_downloads(assets, known),
            {"clock": 15, "documents-to-markdown": 3},
        )

    def test_cli_plan_sync_lines_with_real_repo_dist(self) -> None:
        repo_root = pathlib.Path(__file__).resolve().parent.parent
        dist_dir = repo_root / "dist"
        real_archives = sorted(dist_dir.glob("*.tar.gz"))
        self.assertGreaterEqual(len(real_archives), 2)
        healthy, starter, missing = real_archives[0], real_archives[1], real_archives[2]
        fixture = [
            {"id": 10, "name": healthy.name, "state": "uploaded", "size": healthy.stat().st_size, "download_count": 7},
            {"id": 11, "name": starter.name, "state": "starter", "size": 0, "download_count": 0},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            fixture_path = pathlib.Path(tmp) / "assets.json"
            fixture_path.write_text(json.dumps(fixture), encoding="utf-8")
            proc = subprocess.run(
                [
                    sys.executable,
                    str(repo_root / "scripts" / "stats.py"),
                    "--plan-sync",
                    "--assets-json",
                    str(fixture_path),
                    "--dist-dir",
                    str(dist_dir),
                    "--format",
                    "lines",
                ],
                capture_output=True, text=True, check=True,
            )
            lines = proc.stdout.splitlines()
            self.assertIn("KEEP_COUNT\t1", lines)
            self.assertIn(
                f"DELETE\t11\t{starter.name}\tstarter\t0\t{starter.stat().st_size}",
                lines,
            )
            uploads = [line.split("\t", 1)[1] for line in lines if line.startswith("UPLOAD\t")]
            upload_names = {pathlib.Path(p).name for p in uploads}
            self.assertNotIn(healthy.name, upload_names)
            self.assertIn(starter.name, upload_names)
            self.assertIn(missing.name, upload_names)


if __name__ == "__main__":
    unittest.main()
