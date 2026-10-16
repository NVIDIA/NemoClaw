# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""The catalog pairs what the image build declared with Fabric's own descriptors."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

from catalog import PROVENANCE, installed, read_adapters, snapshot
from nemo_fabric_adapter_catalog import get_adapter_descriptor
from runtime_metadata import read_runtime

ADAPTER_ID = "nvidia.fabric.hermes"


class CatalogContract(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        executable = self.root / "bun-9"
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
        (self.root / "bun").symlink_to(executable)
        self.executable = executable
        bridge = self.root / "bridge.py"
        bridge.write_text("# runtime bridge\n")
        self.layout = {
            "schema_version": 1,
            "command": [sys.executable, str(bridge)],
            "environment": {"PATH": str(self.root), "ADAPTER_PYTHON": sys.executable},
            "required_paths": [str(self.root)],
            "policy": {
                "version": 1,
                "filesystem_policy": {"read_only": [str(self.root)], "read_write": []},
                "process": {"run_as_user": "1234", "run_as_group": "1234"},
                "network_policies": {},
            },
        }
        self.manifest = self.root / "runtime.json"
        self.manifest.write_text(json.dumps(self.layout))

    def tearDown(self):
        self.directory.cleanup()

    def declare(self, declared):
        path = self.root / "adapters.json"
        path.write_text(json.dumps(declared))
        return path

    def installed(self, declared):
        return installed(
            "a" * 40, "b" * 64, adapters=self.declare(declared), runtime_manifest=self.manifest
        )

    def test_image_catalog_pairs_declared_adapters_with_fabric_descriptors(self):
        catalog = self.installed({ADAPTER_ID: {"files": ["/opt/runtime"], "binaries": ["bun"]}})
        self.assertEqual(catalog["schema_version"], 2)
        self.assertEqual(
            catalog["adapters"],
            [{"descriptor": get_adapter_descriptor(ADAPTER_ID), "provenance": PROVENANCE}],
        )
        self.assertEqual(catalog["targets"], [])
        self.assertEqual(catalog["runtime_files"], {ADAPTER_ID: ["/opt/runtime"]})
        self.assertEqual(
            catalog["bridge"]["operations"],
            ["validate", "prepare", "configure", "check", "invoke", "serve"],
        )
        self.assertEqual(catalog["runtime"]["command"], self.layout["command"])
        self.assertEqual(catalog["runtime"]["policy"], self.layout["policy"])
        self.assertEqual(
            catalog["runtime"]["binaries"][ADAPTER_ID],
            sorted([str(Path(sys.executable).resolve()), str(self.executable)]),
        )

    def test_bundled_snapshot_lists_descriptors_without_image_facts(self):
        catalog = snapshot("a" * 40, "b" * 64, ["nvidia.fabric.pi", ADAPTER_ID])
        self.assertEqual(
            [adapter["descriptor"]["adapter_id"] for adapter in catalog["adapters"]],
            [ADAPTER_ID, "nvidia.fabric.pi"],
        )
        self.assertEqual(catalog["targets"], [])
        for field in ("bridge", "runtime", "runtime_files"):
            self.assertNotIn(field, catalog)

    def test_an_adapter_fabric_does_not_catalog_fails_the_snapshot(self):
        with self.assertRaises(KeyError):
            snapshot("a" * 40, "b" * 64, ["org.fixture.unknown"])

    def test_an_adapter_without_files_adds_no_runtime_files(self):
        catalog = self.installed({ADAPTER_ID: {"files": [], "binaries": []}})
        self.assertNotIn("runtime_files", catalog)
        self.assertEqual(
            catalog["runtime"]["binaries"][ADAPTER_ID], [str(Path(sys.executable).resolve())]
        )

    def test_invalid_declarations_fail_the_snapshot(self):
        for declared, message in [
            ({}, "at least one adapter"),
            ({ADAPTER_ID: {"files": []}}, "files and binaries"),
            ({ADAPTER_ID: {"files": ["opt/runtime"], "binaries": []}}, "absolute paths"),
            ({ADAPTER_ID: {"files": ["/opt/../etc"], "binaries": []}}, "absolute paths"),
            ({ADAPTER_ID: {"files": {"/opt": True}, "binaries": []}}, "absolute paths"),
            ({ADAPTER_ID: {"files": [], "binaries": ["/usr/bin/bun"]}}, "executable names"),
        ]:
            with self.subTest(declared=declared), self.assertRaisesRegex(ValueError, message):
                read_adapters(self.declare(declared))
        with self.assertRaisesRegex(ValueError, "declare the image's adapters"):
            read_adapters(self.root / "absent.json")

    def test_a_missing_executable_or_manifest_fails_the_snapshot(self):
        with self.assertRaisesRegex(ValueError, "missing required executable"):
            self.installed({ADAPTER_ID: {"files": [], "binaries": ["absent-executable"]}})
        with self.assertRaisesRegex(ValueError, "runtime manifest"):
            installed(
                "a" * 40,
                "b" * 64,
                adapters=self.declare({ADAPTER_ID: {"files": [], "binaries": []}}),
                runtime_manifest=self.root / "missing.json",
            )

    def test_runtime_manifest_validation_is_unchanged(self):
        declared = {ADAPTER_ID: ["bun"]}
        for field, invalid in [
            ("schema_version", True),
            ("command", [str(self.root)]),
            ("command", ["relative/bridge"]),
            ("required_paths", [str(self.root / "absent")]),
            ("environment", {"ADAPTER_PYTHON": str(self.root)}),
            ("environment", {"NEMOCLAW_PROVIDER_NAMES": "injected"}),
        ]:
            self.manifest.write_text(json.dumps({**self.layout, field: invalid}))
            with self.subTest(field=field, invalid=invalid), self.assertRaises(ValueError):
                read_runtime(self.manifest, declared, required=True)


if __name__ == "__main__":
    unittest.main()
