# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import tempfile
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

from author_runtime_msi import NAMESPACE
from build_msi_fixtures import prepare


class FixturePreparationTests(unittest.TestCase):
    def test_fixture_graph_keeps_rollback_faults_distinct_and_descriptors_binary_lf(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            node = root / "node.exe"
            node.write_bytes(b"fixture data only; not executed")
            license_file = root / "LICENSE"
            license_file.write_text("fixture license")
            helper = root / "helper.exe"
            header = bytearray(128)
            header[:2] = b"MZ"
            header[60:64] = (64).to_bytes(4, "little")
            header[64:70] = b"PE\0\0\x64\xaa"
            helper.write_bytes(header)
            result = prepare(
                root / "output", node, license_file, "22.23.2", helper, "a" * 40
            )
            self.assertFalse(result["completeRuntime"])
            self.assertFalse(result["installedAcceptance"])
            self.assertEqual(len(result["fixtures"]), 4)
            for fixture in result["fixtures"]:
                directory = Path(fixture["authoring"]).parent
                descriptor = (directory / "runtime.ready").read_bytes()
                self.assertNotIn(b"\r", descriptor)
                self.assertEqual(len(descriptor.splitlines()), 6)
                self.assertTrue(descriptor.endswith(b"\n"))
                self.assertEqual(
                    (directory / "content/NODE-LICENSE.txt").read_bytes(),
                    license_file.read_bytes(),
                )
                payload = ET.parse(fixture["payloadAuthoring"])
                identifiers = [
                    item.get("Id") for item in payload.iter() if item.get("Id")
                ]
                self.assertTrue(
                    all("-" not in identifier for identifier in identifiers)
                )
            deferred = ET.parse(result["fixtures"][2]["authoring"])
            action = deferred.find(
                "{" + NAMESPACE + "}CustomAction[@Id='FixtureDeferredFailure']"
            )
            self.assertEqual(action.get("Execute"), "deferred")
            commit = ET.parse(result["fixtures"][3]["authoring"])
            action = commit.find(
                "{" + NAMESPACE + "}CustomAction[@Id='NativeRuntimeCommitInstall']"
            )
            self.assertTrue(
                action.get("ExeCommand").endswith(" --fixture-fail-before-admission")
            )


if __name__ == "__main__":
    unittest.main()
