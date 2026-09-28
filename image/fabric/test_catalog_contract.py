# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Packaging transports Fabric discovery without redefining adapter metadata."""

import json
import os
import unittest
from pathlib import Path

from catalog import snapshot
from nemo_fabric import DiscoveryConfig, Fabric


class CatalogContract(unittest.TestCase):
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
