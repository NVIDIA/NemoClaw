# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""The reference image publishes a catalog that deployments can select."""

import json
import unittest
from pathlib import Path

from bridge_contract import capabilities
from dummy_backend import ADAPTER_ID, HEALTH_CHECKS, SETTINGS

INSTALLED = Path("/opt/nemoclaw/dummy_catalog.py")


# The catalog reads the dummy image's installed files, so only that image runs it.
@unittest.skipUnless(INSTALLED.exists(), "runs in the reference dummy image")
class DummyCatalogTest(unittest.TestCase):
    def test_catalog_lists_the_dummy_with_its_bridge_and_runtime(self):
        import dummy_catalog

        catalog = dummy_catalog.snapshot()
        provenance = json.loads(Path("/opt/nemoclaw/provenance.json").read_text())
        self.assertEqual(catalog["fabric_revision"], provenance["fabric_revision"])
        self.assertEqual(catalog["source_sha256"], provenance["source_sha256"])
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
