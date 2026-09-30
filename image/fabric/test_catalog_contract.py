# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Packaging transports Fabric discovery without redefining adapter metadata."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from catalog import snapshot
from nemo_fabric import DiscoveryConfig, Fabric


class CatalogContract(unittest.TestCase):
    def test_bundled_descriptors_do_not_claim_an_installed_bridge(self):
        with tempfile.TemporaryDirectory() as directory:
            catalog = snapshot("a" * 40, "b" * 64, runtime_files=Path(directory, "absent.json"))
        self.assertNotIn("bridge", catalog)

    def snapshot_with_runtime_files(self, declared):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "runtime-files.json")
            path.write_text(json.dumps(declared))
            return snapshot("a" * 40, "b" * 64, runtime_files=path)

    def test_runtime_files_are_recorded_beside_unedited_descriptors(self):
        records = [record.to_mapping() for record in Fabric().discover()]
        self.assertTrue(records, "requires a discoverable Fabric adapter")
        adapter_id = records[0]["descriptor"]["adapter_id"]
        catalog = self.snapshot_with_runtime_files({adapter_id: ["/opt/runtime"]})
        self.assertEqual(catalog["runtime_files"], {adapter_id: ["/opt/runtime"]})
        self.assertEqual(catalog["adapters"], records)

    def test_image_without_runtime_files_adds_no_field(self):
        with tempfile.TemporaryDirectory() as directory:
            catalog = snapshot("a" * 40, "b" * 64, runtime_files=Path(directory, "absent.json"))
        self.assertNotIn("runtime_files", catalog)

    def test_runtime_files_for_an_uncataloged_adapter_fail_the_snapshot(self):
        with self.assertRaisesRegex(ValueError, "org.fixture.absent"):
            self.snapshot_with_runtime_files({"org.fixture.absent": ["/opt/runtime"]})

    def test_relative_runtime_files_fail_the_snapshot(self):
        adapter_id = Fabric().discover()[0].to_mapping()["descriptor"]["adapter_id"]
        with self.assertRaisesRegex(ValueError, "absolute paths"):
            self.snapshot_with_runtime_files({adapter_id: ["opt/runtime"]})

    def test_parent_traversal_runtime_files_fail_the_snapshot(self):
        adapter_id = Fabric().discover()[0].to_mapping()["descriptor"]["adapter_id"]
        with self.assertRaisesRegex(ValueError, "absolute paths"):
            self.snapshot_with_runtime_files({adapter_id: ["/opt/runtime/../../etc"]})

    def test_runtime_files_must_be_a_list_of_paths(self):
        adapter_id = Fabric().discover()[0].to_mapping()["descriptor"]["adapter_id"]
        with self.assertRaisesRegex(ValueError, "absolute paths"):
            self.snapshot_with_runtime_files({adapter_id: {"/opt/runtime": True}})

    def test_installed_catalog_records_image_layout_and_resolved_adapter_executables(self):
        records = [record.to_mapping() for record in Fabric().discover()]
        adapter_id = records[0]["descriptor"]["adapter_id"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "bun-9"
            executable.write_text("#!/bin/sh\nexit 0\n")
            executable.chmod(0o755)
            (root / "bun").symlink_to(executable)
            bridge = root / "bridge.py"
            bridge.write_text("# runtime bridge\n")
            layout = {
                "schema_version": 1,
                "command": [sys.executable, str(bridge)],
                "environment": {"PATH": str(root), "ADAPTER_PYTHON": sys.executable},
                "required_paths": [str(root)],
                "policy": {
                    "version": 1,
                    "filesystem_policy": {"read_only": [str(root)], "read_write": []},
                    "process": {"run_as_user": "1234", "run_as_group": "1234"},
                    "network_policies": {},
                },
            }
            path = root / "runtime.json"
            path.write_text(json.dumps(layout))
            # Requirements remain Fabric-owned; only path resolution belongs to packaging.
            from copy import deepcopy

            owner_records = deepcopy(records)
            owner_records[0]["provenance"] = [{"source": "installed_package"}]
            owner_records[0]["descriptor"].setdefault("requirements", {})["binaries"] = ["bun"]
            with patch("catalog.Fabric") as fabric:
                fabric.return_value.discover.return_value = [
                    type(
                        "Record",
                        (),
                        {
                            "to_mapping": lambda self: owner_records[0],
                            "provenance": owner_records[0]["provenance"],
                        },
                    )()
                ]
                fabric.return_value.discover_targets.return_value = []
                catalog = snapshot("a" * 40, "b" * 64, installed_only=True, runtime_manifest=path)
            self.assertEqual(
                catalog["bridge"],
                {
                    "interface_version": 1,
                    "operations": ["validate", "prepare", "configure", "check", "invoke", "serve"],
                    "health_checks": [],
                },
            )
            self.assertEqual(catalog["runtime"]["command"], layout["command"])
            self.assertEqual(catalog["runtime"]["policy"], layout["policy"])
            self.assertEqual(catalog["runtime"]["environment"], layout["environment"])
            self.assertEqual(
                catalog["runtime"]["binaries"][adapter_id],
                sorted([str(Path(sys.executable).resolve()), str(executable)]),
            )
            self.assertEqual(catalog["adapters"], owner_records[:1])
            from runtime_metadata import read_runtime

            owner_records[0]["descriptor"]["requirements"]["binaries"] = ["absent-executable"]
            with self.assertRaisesRegex(ValueError, "missing required executable"):
                read_runtime(path, owner_records[:1], required=True)
            owner_records[0]["descriptor"]["requirements"]["binaries"] = ["bun"]
            for field, invalid in [
                ("schema_version", True),
                ("command", [str(root)]),
                ("command", ["relative/bridge"]),
                ("required_paths", [str(root / "absent")]),
                ("environment", {"ADAPTER_PYTHON": str(root)}),
                ("environment", {"NEMOCLAW_PROVIDER_NAMES": "injected"}),
            ]:
                bad = {**layout, field: invalid}
                path.write_text(json.dumps(bad))
                with self.subTest(field=field, invalid=invalid), self.assertRaises(ValueError):
                    read_runtime(path, owner_records[:1], required=True)

    def test_installed_snapshot_requires_a_runtime_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "runtime manifest"):
                snapshot(
                    "a" * 40,
                    "b" * 64,
                    installed_only=True,
                    runtime_manifest=Path(directory, "missing.json"),
                )

    def test_snapshot_preserves_owner_records(self):
        records = Fabric().discover()
        catalog = snapshot("a" * 40, "b" * 64)
        self.assertEqual(catalog["adapters"], [record.to_mapping() for record in records])

    def test_snapshot_preserves_fabric_workflow_targets(self):
        records = Fabric().discover_targets()
        catalog = snapshot("a" * 40, "b" * 64)
        self.assertEqual(catalog["targets"], [record.to_mapping() for record in records])

    @unittest.skipUnless(
        os.environ.get("NEMOCLAW_TEST_FABRIC_DESCRIPTOR"), "requires Fabric fixture"
    )
    def test_new_fabric_descriptor_is_discovered_through_packaging(self):
        discovery = DiscoveryConfig(local_paths=[os.environ["NEMOCLAW_TEST_FABRIC_DESCRIPTOR"]])
        records = Fabric().discover(discovery=discovery)
        catalog = snapshot("a" * 40, "b" * 64, discovery=discovery)
        self.assertEqual(catalog["adapters"], [record.to_mapping() for record in records])
        adapter_id = json.loads(Path(os.environ["NEMOCLAW_TEST_FABRIC_DESCRIPTOR"]).read_text())[
            "adapter_id"
        ]
        self.assertTrue(
            any(record["descriptor"]["adapter_id"] == adapter_id for record in catalog["adapters"])
        )
