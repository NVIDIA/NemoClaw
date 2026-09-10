# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Portable behavior controls; actual Windows/MXC qualification is separate."""

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.request
import zipfile
import sys


def load(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(filename)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load("official_builder", "provision-official-runtime.py")
freezer = load("official_freezer", "official-runtime-inventory.py")


class BuildControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_complete_archive_keeps_licenses_and_dynamic_assets(self):
        archive = self.root / "input.zip"
        with zipfile.ZipFile(archive, "w") as handle:
            handle.writestr("official/LICENSE", "official license")
            handle.writestr("official/plugins/custom/resource.json", '{"dynamic":true}')
            handle.writestr("official/runtime.d.ts", "export type Runtime = string")
        output = self.root / "output"
        builder.extract_complete(archive, output, "zip")
        self.assertEqual((output / "LICENSE").read_text(), "official license")
        self.assertEqual(
            json.loads((output / "plugins/custom/resource.json").read_text()),
            {"dynamic": True},
        )
        self.assertTrue((output / "runtime.d.ts").is_file())

    def test_archive_escape_is_rejected(self):
        archive = self.root / "input.zip"
        with zipfile.ZipFile(archive, "w") as handle:
            handle.writestr("official/../../outside", "bad")
        with self.assertRaisesRegex(ValueError, "unsafe path"):
            builder.extract_complete(archive, self.root / "output", "zip")
        self.assertFalse((self.root / "outside").exists())

    def test_real_child_output_and_exit_are_retained(self):
        result = builder.run_owned(
            sys.executable,
            ["-c", "print('OFFICIAL_CHILD_OK')"],
            os.environ.copy(),
            self.root,
            self.root,
            "child",
            timeout=3,
        )
        self.assertTrue(result["passed"])
        self.assertEqual(
            Path(result["stdout"]).read_text().strip(), "OFFICIAL_CHILD_OK"
        )

    def test_real_child_failure_keeps_the_primary_exit(self):
        with self.assertRaisesRegex(RuntimeError, "exited 7"):
            builder.run_owned(
                sys.executable,
                [
                    "-c",
                    "import sys; print('primary failure',file=sys.stderr); sys.exit(7)",
                ],
                os.environ.copy(),
                self.root,
                self.root,
                "failure",
                timeout=3,
            )
        receipt = json.loads((self.root / "failure.process.json").read_text())
        self.assertEqual(receipt["exitCode"], 7)
        self.assertIn("primary failure", Path(receipt["stderr"]).read_text())
        self.assertFalse(receipt["passed"])

    def test_real_hanging_child_is_bounded(self):
        with self.assertRaises(TimeoutError):
            builder.run_owned(
                sys.executable,
                ["-c", "import time;time.sleep(60)"],
                os.environ.copy(),
                self.root,
                self.root,
                "timeout",
                timeout=0.1,
            )
        receipt = json.loads((self.root / "timeout.process.json").read_text())
        self.assertIsNotNone(receipt["exitCode"])
        self.assertLess(receipt["elapsedSeconds"], 5)
        self.assertFalse(receipt["passed"])

    def test_receipt_write_failure_does_not_replace_actual_child_failure(self):
        with mock.patch.object(
            builder, "write_json", side_effect=OSError("receipt-write-denied")
        ):
            with self.assertRaisesRegex(RuntimeError, "exited 7") as captured:
                builder.run_owned(
                    sys.executable,
                    ["-c", "import sys;sys.exit(7)"],
                    os.environ.copy(),
                    self.root,
                    self.root,
                    "receipt-failure",
                    timeout=3,
                )
        self.assertIn("receipt-write-denied", " ".join(captured.exception.__notes__))

    def test_local_mirror_serves_only_exact_pinned_paths(self):
        artifact = self.root / "artifact.zip"
        artifact.write_bytes(b"immutable archive control")
        with builder.artifact_mirror({"/exact.zip": artifact}) as endpoint:
            with urllib.request.urlopen(endpoint + "/exact.zip") as response:
                self.assertEqual(response.read(), artifact.read_bytes())
            with self.assertRaises(urllib.error.HTTPError) as captured:
                urllib.request.urlopen(endpoint + "/../artifact.zip")
            self.assertEqual(captured.exception.code, 404)
            captured.exception.close()

    def build_receipts(self):
        runtime = self.root / "moved-runtime"
        runtime.mkdir()
        build = {
            "schemaVersion": 1,
            "upstreamCommit": freezer.UPSTREAM_COMMIT,
            "status": "runtime-provisioned",
            "installedTier": "hash-verified (uv.lock)",
            "fallbacks": [],
            "sourceUnchanged": True,
            "stages": [
                {"stage": name, "ok": True, "skipped": False}
                for name in freezer.REQUIRED_STAGES
            ],
        }
        relocation = {
            "schemaVersion": 1,
            "upstreamCommit": freezer.UPSTREAM_COMMIT,
            "status": "pass",
            "targetRoot": str(runtime),
            "sourceRoot": str(self.root / "unavailable-original"),
            "originalRootUnavailable": True,
            "containedInMxc": True,
            "cleanupPassed": True,
            "checks": [
                {"name": name, "passed": True} for name in freezer.REQUIRED_CHECKS
            ],
        }
        return runtime, build, relocation

    def test_freeze_gate_requires_complete_stage_set(self):
        runtime, build, relocation = self.build_receipts()
        build["stages"] = []
        with self.assertRaisesRegex(ValueError, "stage set"):
            freezer.validate_receipts(runtime, build, relocation)

    def test_freeze_gate_rejects_reachable_original_root(self):
        runtime, build, relocation = self.build_receipts()
        Path(relocation["sourceRoot"]).mkdir()
        with self.assertRaisesRegex(ValueError, "original runtime is still reachable"):
            freezer.validate_receipts(runtime, build, relocation)

    def test_freeze_gate_rejects_dependency_fallback(self):
        runtime, build, relocation = self.build_receipts()
        build["installedTier"] = "core only (no extras)"
        with self.assertRaisesRegex(ValueError, "locked provisioning"):
            freezer.validate_receipts(runtime, build, relocation)

    def test_freeze_gate_rejects_failed_conpty(self):
        runtime, build, relocation = self.build_receipts()
        next(check for check in relocation["checks"] if check["name"] == "conpty")[
            "passed"
        ] = False
        with self.assertRaisesRegex(ValueError, "capability failed"):
            freezer.validate_receipts(runtime, build, relocation)

    def test_inventory_records_all_bytes_without_pruning_debug_candidates(self):
        (self.root / "LICENSE").write_text("License text")
        (self.root / "runtime.d.ts").write_text("export type Item = string")
        (self.root / "runtime.js.map").write_text('{"sources":[]}')
        (self.root / "runtime.pdb").write_bytes(b"native symbols")
        value = freezer.inventory(self.root)
        self.assertEqual(
            {item["path"] for item in value["files"]},
            {"LICENSE", "runtime.d.ts", "runtime.js.map", "runtime.pdb"},
        )
        self.assertEqual(value["licenseFiles"], ["LICENSE"])
        self.assertEqual(
            {item["path"] for item in value["diagnosticsCandidates"]},
            {"runtime.d.ts", "runtime.js.map", "runtime.pdb"},
        )
        self.assertFalse(value["diagnosticsRemovalValidated"])


if __name__ == "__main__":
    unittest.main()
