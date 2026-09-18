#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Recipe-owned recovery rules, without a model download or GPU."""
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

NAME = "language_model.model.layers.1.ple.ple_embedding.ngram_embedding.packed_u8"


class PreparationRecovery(unittest.TestCase):
    def invoke(self, output, previous, inspect):
        request = {"apiVersion": "nemoclaw.nvidia.com/recipe-execution/v1",
                   "modelDirectory": str(output.parent / "model"),
                   "outputDirectory": str(output),
                   "previousDirectory": str(previous) if previous else None}
        with patch("sys.stdin", io.StringIO(json.dumps(request))), patch("subprocess.run", side_effect=inspect) as runner:
            runpy.run_path(str(Path(__file__).with_name("prepare.py")), run_name="__main__")
            runner.assert_called_once()

    def test_unpublished_orphan_is_removed_before_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / NAME).write_bytes(b"incomplete")
            def inspect(*args, **kwargs):
                self.assertFalse((output / NAME).exists())
                self.assertTrue(kwargs["check"])
            self.invoke(output, None, inspect)

    def test_import_preserves_published_bytes_and_only_offers_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous, output = root / "previous", root / "staging"
            previous.mkdir()
            output.mkdir()
            for name in [NAME, NAME + ".json"]:
                (previous / name).write_bytes(b"candidate")
            def inspect(*args, **kwargs):
                for name in [NAME, NAME + ".json"]:
                    self.assertEqual((output / name).read_bytes(), b"candidate")
                    self.assertEqual((previous / name).read_bytes(), b"candidate")
                self.assertFalse((output / "manifest.json").exists())
            self.invoke(output, previous, inspect)


if __name__ == "__main__":
    unittest.main()
