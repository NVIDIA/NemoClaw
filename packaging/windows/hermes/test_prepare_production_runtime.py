# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Data-only partition controls; fixtures never execute runtime or downloaded code."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import unittest.mock as mock

SPEC = importlib.util.spec_from_file_location(
    "hermes_production", Path(__file__).with_name("prepare-production-runtime.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PartitionControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "copy"
        self.root.mkdir()
        self.content = {
            "hermes-agent/tests/case.py": b"test-only bytes",
            "hermes-agent/tests/test_failure_notice.py": b"ambiguous notice retained",
            "hermes-agent/tests/LICENSE": b"license retained",
            "hermes-agent/tests/package.json": b"{}",
            "hermes-agent/.github/workflows/check.yaml": b"development-only",
            "hermes-agent/plugins/live/index.js": b"runtime JavaScript retained",
            "hermes-agent/plugins/live/index.js.map": b'{"version":3,"sources":[]}',
            "hermes-agent/plugins/live/index.d.mts": b"declaration-only",
            "hermes-agent/plugins/live/custom.pdb": b"unknown plugin resource retained",
            "hermes-agent/skills/example/scripts/work.py": b"dynamic skill retained",
            "git/usr/share/perl5/core_perl/Test/Simple.pm": b"runtime Perl retained",
            MODULE.GIT_DOCUMENTATION_SOURCE + "git-help.adoc": b"help build input",
            MODULE.GIT_DOCUMENTATION_SOURCE + "RelNotes/2.54.0.adoc": b"release source",
            MODULE.GIT_DOCUMENTATION_SOURCE
            + "git-help.html": b"generated help retained",
            MODULE.GIT_DOCUMENTATION_SOURCE + "LICENSE.adoc": b"license retained",
            MODULE.GIT_DOCUMENTATION_SOURCE + "legal/topic.adoc": b"legal retained",
            "git/usr/share/man/man1/git-help.1": b"manual retained",
            "ffmpeg/bin/ffmpeg.exe": b"messaging transcode retained",
            "ffmpeg/bin/ffprobe.exe": b"messaging probe retained",
            "ffmpeg/bin/ffplay.exe": b"unused interactive player",
            "ffmpeg/doc/index.html": b"development documentation",
            "ffmpeg/LICENSE": b"ffmpeg license retained",
            "hermes-agent/skills/topic.adoc": b"unrelated dynamic resource retained",
            "hermes-agent/website/static/api/model-catalog.json": b"{}",
            "hermes-agent/website/LICENSE": b"website license retained in archive",
            "licenses/package/shape.d.ts": b"license directory retained",
            "browsers/chromium/ABOUT": b"inventory-only license retained",
            "hermes-agent/venv/Lib/site-packages/pkg.dist-info/METADATA": b"metadata retained",
            MODULE.SYMBOL_ROOT + "python311.pdb": b"diagnostic symbols only",
            MODULE.SYMBOL_ROOT + "DLLs/_testcapi.pyd": b"native test extension",
            MODULE.SYMBOL_ROOT + "DLLs/_ssl.pyd": b"working extension retained",
        }
        for name, content in self.content.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        self.inventory = {
            "files": [
                {
                    "path": name,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
                for name, data in sorted(self.content.items())
            ],
            "directories": sorted(
                p.relative_to(self.root).as_posix()
                for p in self.root.rglob("*")
                if p.is_dir()
            ),
            "licenseFiles": [
                "hermes-agent/tests/LICENSE",
                "hermes-agent/website/LICENSE",
                "browsers/chromium/ABOUT",
            ],
        }

    def test_partition_archives_exact_bytes_before_removing_fixture_files(self):
        with mock.patch("gzip.time.time", return_value=1_000_000_000):
            result = MODULE.partition_copy(
                self.root, self.inventory, self.base / "diagnostics"
            )
        removed = {row["path"] for row in result["files"]}
        self.assertEqual(len(removed), 18)
        self.assertFalse((self.root / "hermes-agent/.github").exists())
        self.assertFalse((self.root / "hermes-agent/website").exists())
        licenses = [r for r in result["files"] if r["path"] in result["archivedLicenseFiles"]]
        MODULE.verify_archive(self.root / "THIRD-PARTY-LICENSES.tar.gz", licenses)
        self.assertFalse((self.root / "ffmpeg/bin/ffmpeg.exe").exists())
        self.assertFalse((self.root / "ffmpeg/bin/ffprobe.exe").exists())
        self.assertFalse((self.root / "ffmpeg/bin/ffplay.exe").exists())
        self.assertFalse((self.root / "ffmpeg/LICENSE").exists())
        self.assertEqual(result["installedLicenseArchive"]["content"]["files"], 3)
        for row in result["archives"]:
            path = self.base / "diagnostics" / row["file"]
            self.assertEqual(
                hashlib.sha256(path.read_bytes()).hexdigest(), row["sha256"]
            )
        for name, data in self.content.items():
            if name in removed:
                self.assertFalse((self.root / name).exists())
            else:
                self.assertEqual((self.root / name).read_bytes(), data)
        other = self.base / "other-copy"
        for name, data in self.content.items():
            path = other / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            os.utime(path, (2_000_000_000, 2_000_000_000))
        with mock.patch("gzip.time.time", return_value=2_000_000_000):
            repeated = MODULE.partition_copy(
                other, self.inventory, self.base / "another-time-and-directory"
            )
        self.assertEqual(result["archives"], repeated["archives"])
        for row in result["archives"]:
            original = (self.base / "diagnostics" / row["file"]).read_bytes()
            rebuilt = (
                self.base / "another-time-and-directory" / row["file"]
            ).read_bytes()
            self.assertEqual(original, rebuilt)
            self.assertEqual(original[4:8], b"\0\0\0\0")
            self.assertEqual(original[3] & 8, 0, "gzip must omit its output filename")

    def test_changed_candidate_prevents_any_partition(self):
        target = self.root / "hermes-agent/tests/case.py"
        target.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Candidate bytes changed"):
            MODULE.partition_copy(self.root, self.inventory, self.base / "diagnostics")
        self.assertFalse((self.base / "diagnostics").exists())
        self.assertEqual(
            len([p for p in self.root.rglob("*") if p.is_file()]), len(self.content)
        )

    def test_archive_verification_failure_keeps_fixture_source_bytes(self):
        with mock.patch.object(
            MODULE, "verify_archive", side_effect=ValueError("archive failed")
        ):
            with self.assertRaisesRegex(ValueError, "archive failed"):
                MODULE.partition_copy(
                    self.root, self.inventory, self.base / "diagnostics"
                )
        for name, data in self.content.items():
            self.assertEqual((self.root / name).read_bytes(), data)

    def test_generated_metadata_collision_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Generated metadata references"):
            MODULE.make_plan(self.inventory, {"hermes-agent/tests/case.py"})

    def test_alias_and_traversal_inventory_is_rejected(self):
        for invalid in ("../outside", "hermes-agent/../outside", "C:/outside"):
            bad = {
                **self.inventory,
                "files": [{**self.inventory["files"][0], "path": invalid}],
            }
            with self.assertRaisesRegex(ValueError, "Invalid partition path"):
                MODULE.make_plan(bad)
        bad = {
            **self.inventory,
            "files": [self.inventory["files"][0], self.inventory["files"][0]],
        }
        with self.assertRaisesRegex(ValueError, "ambiguous source inventory"):
            MODULE.make_plan(bad)

    def test_symlink_candidate_is_not_followed(self):
        target = self.root / "hermes-agent/tests/case.py"
        target.unlink()
        outside = self.base / "outside"
        outside.write_bytes(self.content["hermes-agent/tests/case.py"])
        try:
            target.symlink_to(outside)
        except OSError:
            self.skipTest("Host cannot create an ordinary symlink fixture")
        with self.assertRaisesRegex(ValueError, "link or reparse"):
            MODULE.partition_copy(self.root, self.inventory, self.base / "diagnostics")
        self.assertEqual(
            outside.read_bytes(), self.content["hermes-agent/tests/case.py"]
        )

    def test_real_entry_requires_windows_ci(self):
        with mock.patch.object(MODULE.os, "name", "posix"):
            with self.assertRaisesRegex(ValueError, "requires Windows CI"):
                MODULE.prepare(self.root, "unused", self.base / "unused")

    @unittest.skipUnless(
        os.environ.get("HERMES_PRUNING_INVENTORY"),
        "Canonical inventory path not supplied",
    )
    def test_full_verified_inventory_plan(self):
        payload = json.loads(Path(os.environ["HERMES_PRUNING_INVENTORY"]).read_text())
        plan = MODULE.make_plan(payload)
        self.assertEqual(plan["before"], {"files": 57820, "bytes": 2919342369})
        self.assertEqual(plan["removed"], {"files": 12423, "bytes": 178228223})
        self.assertEqual(plan["remaining"], {"files": 45397, "bytes": 2741114146})
        self.assertEqual(
            plan["licenseCounts"],
            {
                "inventory": 1353,
                "earlierClassifier": 1384,
                "overlap": 1348,
                "retainedUnion": 1389,
            },
        )
        groups = {
            group: [row for row in plan["files"] if row["group"] == group]
            for group in ("development", "diagnostic-symbols")
        }
        self.assertEqual(
            MODULE.totals(groups["development"]), {"files": 12386, "bytes": 96140287}
        )
        self.assertEqual(
            MODULE.totals(groups["diagnostic-symbols"]),
            {"files": 37, "bytes": 82087936},
        )


if __name__ == "__main__":
    unittest.main()
