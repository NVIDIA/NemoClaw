# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Portable authoring controls, not Windows Installer execution evidence."""

import hashlib
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from author_runtime_msi import NAMESPACE, author, validate_identity


class AuthoringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.helper = Path(self.temp.name) / "fixture.exe"
        # Header-only fixture exercises the build parser; it is never executed
        # and does not claim to implement the native transaction protocol.
        data = bytearray(128)
        data[:2] = b"MZ"
        data[60:64] = (64).to_bytes(4, "little")
        data[64:70] = b"PE\0\0\x64\xaa"
        self.helper.write_bytes(data)
        self.digest = hashlib.sha256(data).hexdigest()
        self.identity = {
            "runtimeId": "a" * 64,
            "manifestSha256": "b" * 64,
            "sourceRevision": "c" * 40,
            "nodeSha256": "d" * 64,
            "nodeVersion": "22.23.2",
        }

    def authored(self):
        xml, receipt = author(self.identity, self.helper, self.digest)
        return ET.fromstring(xml), receipt

    def test_retirement_is_flushed_before_standard_component_mutation(self):
        tree, _ = self.authored()
        sequence = tree.find("{" + NAMESPACE + "}InstallExecuteSequence")
        orders = {
            item.get("Action", item.tag.split("}")[1]): int(item.get("Sequence"))
            for item in sequence
        }
        self.assertLess(1500, orders["NativeRuntimeRollback"])
        self.assertLess(
            orders["NativeRuntimeRollback"], orders["NativeRuntimeBeginInstall"]
        )
        self.assertLess(orders["NativeRuntimeBeginInstall"], orders["InstallExecute"])
        self.assertLess(orders["NativeRuntimeBeginRemove"], orders["InstallExecute"])
        self.assertLess(orders["NativeRuntimeJoinRemoval"], orders["InstallExecute"])
        self.assertLess(orders["InstallExecute"], 1600)
        self.assertGreater(orders["NativeRuntimeVerify"], 4000)

    def test_each_native_action_is_embedded_synchronous_and_elevated(self):
        tree, receipt = self.authored()
        actions = tree.findall("{" + NAMESPACE + "}CustomAction")
        self.assertEqual(len(actions), 7)
        for action in actions:
            self.assertEqual(action.get("BinaryRef"), "NativeRuntimeTransaction")
            self.assertEqual(action.get("Impersonate"), "no")
            self.assertEqual(action.get("Return"), "check")
            self.assertNotIn("FileRef", action.attrib)
        modes = {item.get("Id"): item.get("Execute") for item in actions}
        self.assertEqual(modes["NativeRuntimeRollback"], "rollback")
        self.assertEqual(modes["NativeRuntimeCommitInstall"], "commit")
        self.assertFalse(receipt["installedExecution"])

    def test_direct_maintenance_and_nested_removal_have_distinct_guard_actions(self):
        tree, _ = self.authored()
        sequence = tree.find("{" + NAMESPACE + "}InstallExecuteSequence")
        conditions = {
            item.get("Action"): item.get("Condition")
            for item in sequence
            if item.get("Action")
        }
        self.assertIn('REMOVE ~= "ALL"', conditions["NativeRuntimeBeginRemove"])
        self.assertIn(
            "NOT UPGRADINGPRODUCTCODE", conditions["NativeRuntimeBeginInstall"]
        )
        self.assertEqual(conditions["NativeRuntimeJoinRemoval"], "UPGRADINGPRODUCTCODE")
        self.assertEqual(
            conditions["NativeRuntimeRollback"], "NOT UPGRADINGPRODUCTCODE"
        )
        self.assertEqual(
            tree.find("{" + NAMESPACE + "}Launch").get("Condition"),
            "NOT RollbackDisabled",
        )

    def test_modified_embedded_helper_is_rejected(self):
        self.helper.write_bytes(self.helper.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "bytes changed"):
            author(self.identity, self.helper, self.digest)

    def test_x64_helper_is_not_labeled_native_arm64(self):
        data = bytearray(self.helper.read_bytes())
        data[68:70] = b"\x64\x86"
        self.helper.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "native Windows ARM64"):
            author(self.identity, self.helper, hashlib.sha256(data).hexdigest())

    def test_runtime_and_shared_node_identity_are_required(self):
        del self.identity["nodeSha256"]
        with self.assertRaisesRegex(ValueError, "exactly"):
            validate_identity(self.identity)

    def test_untrusted_path_cannot_enter_fixed_root_native_arguments(self):
        self.identity["runtimeId"] = "../foreign"
        with self.assertRaisesRegex(ValueError, "invalid identity"):
            validate_identity(self.identity)


if __name__ == "__main__":
    unittest.main()
