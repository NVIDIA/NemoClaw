# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Verify assembled agent images using only their installed runtime."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path


class AgentImage(unittest.TestCase):
    def test_runtime_uses_current_compatible_python_and_node_lts(self):
        python = (
            (3, 13, 15)
            if os.environ["NEMOCLAW_TEST_HARNESS"] in {"nooa", "nooa-bench", "hermes"}
            else (3, 14, 7)
        )
        self.assertEqual(sys.version_info[:3], python)
        self.assertEqual(
            subprocess.check_output(["node", "--version"], text=True).strip(), "v24.21.0"
        )

    def test_runtime_retains_matching_sources_without_build_toolchains(self):
        root = Path("/opt/nemoclaw")
        manifest = json.loads((root / "provenance.json").read_text())
        self.assertEqual(manifest["harness"], os.environ["NEMOCLAW_TEST_HARNESS"])
        sources = root / "source"
        for name, expected in manifest["local_sources"].items():
            self.assertEqual(
                hashlib.sha256((sources / "local" / name).read_bytes()).hexdigest(), expected, name
            )
        self.assertEqual(
            hashlib.sha256((sources / "fabric.tar.gz").read_bytes()).hexdigest(),
            manifest["source_sha256"],
        )
        self.assertEqual(
            hashlib.sha256((sources / "requirements.txt").read_bytes()).hexdigest(),
            manifest["requirements_sha256"],
        )
        for path in root.glob("*.py"):
            self.assertEqual(path.read_bytes(), (sources / "local" / path.name).read_bytes())
        self.assertEqual(os.getuid(), 1000)
        self.assertEqual(Path("/sandbox").stat().st_uid, 1000)
        for tool in ("rustc", "cargo", "uv", "gcc"):
            self.assertIsNone(shutil.which(tool), tool)


if __name__ == "__main__":
    unittest.main()
