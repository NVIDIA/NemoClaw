# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Keep reusable CI bound to the caller's selected source revision."""

import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class E2ESuite(unittest.TestCase):
    def test_both_workflows_accept_and_checkout_the_same_revision(self):
        for name in ("rust", "images"):
            with self.subTest(workflow=name):
                source = (ROOT / f".github/workflows/{name}.yml").read_text()
                self.assertIn("  workflow_call:\n", source)
                self.assertIn("      source-ref:\n", source)
                self.assertIn("          ref: ${{ inputs.source-ref || github.sha }}", source)
                # Standalone PR checks and aggregate calls must not cancel each other.
                self.assertRegex(source, r"group: .*\$\{\{ github.workflow \}\}")

    def test_lifecycle_includes_new_isolated_fixtures(self):
        config = tomllib.loads((ROOT / ".config/nextest.toml").read_text())
        selection = config["profile"]["lifecycle"]["default-filter"]
        for binary in ("gateway_readiness", "inference_discovery", "discovery"):
            self.assertIn(f"binary(={binary})", selection)
        # The fourth discovery test needs an installed external Fabric fixture.
        self.assertIn(
            "!test(=fabric_owned_adapter_settings_reach_real_planning_without_consumer_manifests)",
            selection,
        )
        for binary in ("brev", "spark", "model_live", "fabric_live", "managed",
                       "hosted_parity", "cache_provider", "docker_provider_proxy"):
            self.assertNotIn(f"binary(={binary})", selection)


if __name__ == "__main__":
    unittest.main()
