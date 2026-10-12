# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""The reference image publishes a catalog that deployments can select."""

import json
import os
import unittest
from pathlib import Path

from bridge_contract import capabilities
from dummy_backend import ADAPTER_ID, HEALTH_CHECKS, SETTINGS


# The catalog reads the dummy image's installed files, so only the stage that
# sets this runs it; there, a missing installed file fails instead of skipping.
@unittest.skipUnless(
    os.environ.get("NEMOCLAW_REFERENCE_TESTS") == "1", "runs in the reference-tests stage"
)
class DummyCatalogTest(unittest.TestCase):
    def test_catalog_lists_the_dummy_with_its_bridge_and_runtime(self):
        import dummy_catalog

        catalog = dummy_catalog.snapshot()
        contract = json.loads(Path("/opt/nemoclaw/contract.json").read_text())
        self.assertEqual(catalog["fabric_revision"], contract["fabric_revision"])
        self.assertEqual(catalog["source_sha256"], contract["source_sha256"])
        self.assertEqual(len(catalog["fabric_revision"]), 40)
        self.assertEqual(
            [record["descriptor"]["adapter_id"] for record in catalog["adapters"]], [ADAPTER_ID]
        )
        self.assertEqual(catalog["bridge"], capabilities(HEALTH_CHECKS))
        self.assertEqual(
            catalog["bridge"], json.loads(Path("/opt/nemoclaw/bridge.json").read_text())
        )
        binaries = catalog["runtime"]["binaries"][ADAPTER_ID]
        self.assertEqual(binaries, [str(Path("/opt/fabric/bin/python").resolve(strict=True))])

    def test_descriptor_settings_match_the_backend(self):
        descriptor = json.loads(Path("/opt/nemoclaw/dummy.fabric-adapter.json").read_text())
        schema_types = {str: "string", bool: "boolean"}
        self.assertEqual(
            {
                name: setting["type"]
                for name, setting in descriptor["settings_schema"]["properties"].items()
            },
            {name: schema_types[kind] for name, kind in SETTINGS.items()},
        )
        self.assertIs(descriptor["settings_schema"]["additionalProperties"], False)


if __name__ == "__main__":
    unittest.main()
