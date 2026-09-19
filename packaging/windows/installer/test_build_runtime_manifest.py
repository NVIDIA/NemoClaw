# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import hashlib
import os
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

from build_runtime_manifest import build, validate_relative


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "runtime"
        self.root.mkdir()
        (self.root / "data.txt").write_bytes(b"actual content")
        self.node = self.base / "node.exe"
        self.node.write_bytes(b"fixture identity only, never executed")

    def manifest(self):
        return build(self.root, self.node, "a" * 40, "22.23.2", "e" * 64)

    def test_complete_inventory_binds_files_directories_and_shared_node(self):
        (self.root / "empty").mkdir()
        content, identity = self.manifest()
        self.assertEqual(
            identity["manifestSha256"], hashlib.sha256(content).hexdigest()
        )
        self.assertEqual(identity["runtimeId"], "e" * 64)
        self.assertEqual(
            identity["nodeSha256"], hashlib.sha256(self.node.read_bytes()).hexdigest()
        )
        self.assertIn(b"D\t-\t0\t656d707479\n", content)
        self.assertIn(hashlib.sha256(b"actual content").hexdigest().encode(), content)

    def test_changing_final_bytes_changes_the_digest_without_a_recursive_namespace(
        self,
    ):
        original = self.manifest()[1]
        (self.root / "data.txt").write_bytes(b"changed production content")
        self.assertNotEqual(
            self.manifest()[1]["manifestSha256"], original["manifestSha256"]
        )

    def test_installer_control_file_cannot_be_supplied_as_production_content(self):
        (self.root / "runtime.ready").write_text("forged marker")
        with self.assertRaisesRegex(ValueError, "control files"):
            self.manifest()

    def test_redirected_input_is_rejected_without_following_it(self):
        (self.root / "foreign").symlink_to(self.node)
        with self.assertRaisesRegex(ValueError, "redirected"):
            self.manifest()

    def test_byte_inventory_accepts_build_cache_hardlinks_without_claiming_installed_link_safety(
        self,
    ):
        os.link(self.root / "data.txt", self.root / "copy.txt")
        content, _ = self.manifest()
        digest = hashlib.sha256(b"actual content").hexdigest().encode()
        self.assertEqual(content.count(digest), 2)
        # Native installed-content validation independently requires linkCount1.

    def test_actual_cli_binds_the_preassigned_namespace_and_exact_descriptor(self):
        manifest = self.base / "output.manifest"
        identity = self.base / "identity.json"
        ready = self.base / "runtime.ready"
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("build_runtime_manifest.py")),
                "--runtime-content-root",
                str(self.root),
                "--shared-node",
                str(self.node),
                "--source-revision",
                "a" * 40,
                "--node-version",
                "22.23.2",
                "--runtime-id",
                "e" * 64,
                "--manifest",
                str(manifest),
                "--identity",
                str(identity),
                "--ready-descriptor",
                str(ready),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads(identity.read_text())
        self.assertEqual(record["runtimeId"], "e" * 64)
        self.assertEqual(
            record["manifestSha256"], hashlib.sha256(manifest.read_bytes()).hexdigest()
        )
        self.assertEqual(ready.read_bytes().splitlines()[1], b"e" * 64)
        self.assertNotIn(b"\r", ready.read_bytes())

    def test_ambiguous_windows_filename_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            validate_relative("NUL.txt")


if __name__ == "__main__":
    unittest.main()
