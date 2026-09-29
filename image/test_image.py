# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Verify assembled agent images using only their installed runtime."""

import hashlib
import importlib.metadata
import json
import os
import shutil
import tarfile
import tomllib
import unittest
from pathlib import Path


class AgentImage(unittest.TestCase):
    def test_label_matches_discovery_from_installed_fabric(self):
        from catalog import snapshot

        provenance = json.loads(Path("/opt/nemoclaw/provenance.json").read_text())
        actual = snapshot(
            provenance["fabric_revision"], provenance["source_sha256"], installed_only=True
        )
        self.assertTrue(actual["adapters"], "image installs no discoverable Fabric adapter")
        self.assertEqual(json.loads(os.environ["NEMOCLAW_TEST_CATALOG"]), actual)

    @unittest.skipIf(
        os.environ.get("NEMOCLAW_TEST_HARNESS") == "hermes", "Hermes native supplement"
    )
    def test_installed_dependencies_follow_the_fabric_lock(self):
        with tarfile.open("/opt/nemoclaw/source/fabric.tar.gz") as source:
            lock = next(
                item
                for item in source
                if item.name.count("/") == 1 and item.name.endswith("/uv.lock")
            )
            packages = tomllib.loads(source.extractfile(lock).read().decode())["package"]
        for package in packages:
            if "registry" not in package["source"]:
                continue
            try:
                installed = importlib.metadata.version(package["name"])
            except importlib.metadata.PackageNotFoundError:
                continue
            versions = {item["version"] for item in packages if item["name"] == package["name"]}
            self.assertIn(installed, versions, package["name"])

    @unittest.skipUnless(os.environ.get("NEMOCLAW_TEST_HARNESS") == "pi", "Pi image only")
    def test_pi_installs_packed_adapters_without_source_tests(self):
        root = Path("/opt/fabric-source")
        for package in (
            "adapter-contract/typescript",
            "adapters/typescript/common",
            "adapters/typescript/pi",
        ):
            directory = root / package
            manifest = json.loads((directory / "package.json").read_text())
            self.assertEqual(
                {path.name for path in directory.iterdir()},
                set(manifest["files"]) | {"package.json"},
                package,
            )
        self.assertFalse((root / "adapters/typescript/opencode").exists())

    @unittest.skipUnless(os.environ.get("NEMOCLAW_TEST_HARNESS") == "hermes", "Hermes image only")
    def test_hermes_accepts_fabric_request_metadata(self):
        from gateway.platforms.api_server import _request_relay_metadata

        metadata = {"request_id": "image-qualification", "context": {"tenant": "owned"}}
        extracted = _request_relay_metadata({"metadata": metadata})
        self.assertEqual(extracted, metadata)
        self.assertIsNot(extracted, metadata)
        self.assertEqual(_request_relay_metadata({"metadata": "invalid"}), {})

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
