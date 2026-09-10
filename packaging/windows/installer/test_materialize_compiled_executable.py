# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).with_name("materialize-compiled-executable.py")
SPEC = importlib.util.spec_from_file_location("compiled_materializer", MODULE)
materializer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(materializer)


class CompiledMaterializationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-artifact-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "cargo.exe"
        self.alias = self.root / "cargo-hash.exe"
        self.output = self.root / "packaged.exe"
        self.receipt = self.root / "receipt.json"
        self.data = b"unchanged compiled bytes\x00\xff" * 4096
        self.source.write_bytes(self.data)
        os.link(self.source, self.alias)

    def copy(self):
        return materializer.materialize(self.source, self.output, self.receipt)

    def test_actual_cli_hardlink_source_becomes_identical_single_link_file(self):
        run = subprocess.run(
            [
                sys.executable,
                str(MODULE),
                "--source",
                str(self.source),
                "--output",
                str(self.output),
                "--receipt",
                str(self.receipt),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(self.source.stat().st_nlink, 2)
        self.assertEqual(self.output.stat().st_nlink, 1)
        self.assertEqual(self.source.read_bytes(), self.data)
        self.assertEqual(self.alias.read_bytes(), self.data)
        self.assertEqual(self.output.read_bytes(), self.data)
        record = json.loads(self.receipt.read_text())
        self.assertEqual(record["status"], "materialized")
        self.assertEqual(record["sourceStatBefore"]["links"], 2)
        self.assertEqual(record["sourceStatAfter"]["links"], 2)
        self.assertEqual(record["sourceSha256Before"], record["sourceSha256After"])
        self.assertEqual(record["sourceSha256Before"], record["outputSha256"])
        self.assertFalse(record["runtimeLaunchCopy"])

    def test_existing_output_and_receipt_are_never_overwritten(self):
        self.output.write_bytes(b"keep existing")
        with self.assertRaises(FileExistsError):
            self.copy()
        self.assertEqual(self.output.read_bytes(), b"keep existing")
        self.assertEqual(json.loads(self.receipt.read_text())["status"], "failed")
        self.output.unlink()
        before = self.receipt.read_bytes()
        with self.assertRaises(FileExistsError):
            self.copy()
        self.assertEqual(self.receipt.read_bytes(), before)
        self.assertFalse(self.output.exists())

    def test_redirected_source_parent_and_output_parent_are_refused(self):
        link = self.root / "redirect.exe"
        link.symlink_to(self.source)
        redirected_parent = self.root / "redirected-parent"
        redirected_parent.symlink_to(self.root, target_is_directory=True)
        cases = [
            (link, self.output),
            (redirected_parent / self.source.name, self.output),
            (self.source, redirected_parent / self.output.name),
        ]
        for index, (source, output) in enumerate(cases):
            with self.subTest(index=index):
                with self.assertRaisesRegex(ValueError, "link or reparse"):
                    materializer.materialize(
                        source, output, self.root / f"failed-{index}.json"
                    )
                self.assertFalse(self.output.exists())

    def test_directory_source_is_refused_with_failure_diagnostics(self):
        with self.assertRaisesRegex(ValueError, "ordinary files"):
            materializer.materialize(self.root, self.output, self.receipt)
        self.assertFalse(self.output.exists())
        self.assertEqual(json.loads(self.receipt.read_text())["status"], "failed")


if __name__ == "__main__":
    unittest.main()
