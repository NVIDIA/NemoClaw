# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Exercise corrections against the verified source provided by the build stage."""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from patch_hermes import patch_hermes
from patch_pi import patch_pi


@unittest.skipUnless(os.environ.get("NEMOCLAW_FABRIC_SOURCE"), "requires verified Fabric source")
class UpstreamPatches(unittest.TestCase):
    def test_hermes_retains_sampling_and_adds_explicit_api_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            relative = "adapters/python/hermes"
            shutil.copytree(Path(os.environ["NEMOCLAW_FABRIC_SOURCE"]) / relative, root / relative)
            patch_hermes(root)
            descriptor = json.loads((root / relative / "hermes.fabric-adapter.json").read_text())
            self.assertIn("models.max_tokens", descriptor["config"]["accepts"])
            self.assertIn(
                "anthropic_messages",
                descriptor["settings_schema"]["properties"]["api_mode"]["enum"],
            )
            with self.assertRaises(ValueError):
                patch_hermes(root)

    def test_pi_rejects_changed_lifecycle_without_partially_patching_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            relative = "adapters/typescript/pi"
            shutil.copytree(Path(os.environ["NEMOCLAW_FABRIC_SOURCE"]) / relative, root / relative)
            sdk = root / relative / "src/pi-sdk.ts"
            sdk.write_text(
                sdk.read_text().replace(
                    "handle = new PiSdkSessionHandle(session, state, relay);",
                    "handle = createSessionHandle(session, state, relay);",
                )
            )
            before = {p: p.read_bytes() for p in (root / relative).rglob("*") if p.is_file()}
            with self.assertRaisesRegex(ValueError, "lifecycle"):
                patch_pi(root)
            self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_pi_model_correction_rejects_an_already_modified_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            relative = "adapters/typescript/pi"
            shutil.copytree(Path(os.environ["NEMOCLAW_FABRIC_SOURCE"]) / relative, root / relative)
            patch_pi(root)
            with self.assertRaises(ValueError):
                patch_pi(root)


if __name__ == "__main__":
    unittest.main()
