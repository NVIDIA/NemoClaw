# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
import tempfile
import unittest
from assign_runtime_namespace import assign


class NamespaceTests(unittest.TestCase):
    def test_same_inputs_reuse_the_exact_preassigned_record_without_rewriting(self):
        with tempfile.TemporaryDirectory() as temporary:
            receipt = Path(temporary) / "namespace.json"
            first = assign(receipt, "a" * 40, "b" * 64)
            before = receipt.read_bytes()
            second = assign(receipt, "a" * 40, "b" * 64)
            self.assertEqual(first, second)
            self.assertEqual(len(first["runtimeId"]), 64)
            self.assertEqual(receipt.read_bytes(), before)

    def test_changed_component_graph_cannot_reuse_an_existing_namespace(self):
        with tempfile.TemporaryDirectory() as temporary:
            receipt = Path(temporary) / "namespace.json"
            assign(receipt, "a" * 40, "b" * 64)
            before = receipt.read_bytes()
            with self.assertRaisesRegex(ValueError, "changed inputs"):
                assign(receipt, "a" * 40, "c" * 64)
            self.assertEqual(receipt.read_bytes(), before)

    def test_two_fresh_build_receipts_have_distinct_namespaces(self):
        with tempfile.TemporaryDirectory() as temporary:
            first = assign(Path(temporary) / "first.json", "a" * 40, "b" * 64)
            second = assign(Path(temporary) / "second.json", "a" * 40, "b" * 64)
            self.assertNotEqual(first["runtimeId"], second["runtimeId"])


if __name__ == "__main__":
    unittest.main()
