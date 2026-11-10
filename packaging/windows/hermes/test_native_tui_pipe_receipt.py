# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "hermes_node_builder", Path(__file__).with_name("build-official-node.py")
)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class NativeTuiPipeReceipt(unittest.TestCase):
    def run_adapter(self, change=None):
        with tempfile.TemporaryDirectory() as directory:
            build = Path(directory).resolve()
            source = build / "ui-tui/src/gatewayClient.ts"
            source.parent.mkdir(parents=True)
            source.write_text("unit-test original; not a native build\n")
            adapter = Path(BUILDER.__file__).with_name("native-tui-pipe-build.mts")

            def invoke(node, args, *, cwd, label):
                self.assertEqual(node, "unit-test-node-not-executed")
                self.assertEqual(args, [adapter.resolve(), build])
                self.assertEqual(cwd, build)
                self.assertEqual(label, "native-tui-pipe-adapter")
                original = BUILDER.digest(source)
                source.write_text("unit-test adapted; not a native build\n")
                receipt = {
                    "schemaVersion": 1,
                    "classification": "build-time-hermes-dashboard-pipe-client",
                    "path": "ui-tui/src/gatewayClient.ts",
                    "sourceSha256": original,
                    "adapterSha256": BUILDER.digest(adapter),
                    "adaptedSha256": BUILDER.digest(source),
                    "callSites": 2,
                    "nativeExecutionQualified": False,
                }
                if change:
                    receipt.update(change)
                output = build / "unit-test-adapter-receipt.json"
                output.write_text(json.dumps(receipt))
                return {"stdout": output}

            return BUILDER.adapt_tui_transport(
                "unit-test-node-not-executed", build, invoke
            )

    def test_receipt_binds_input_adapter_and_actual_output(self):
        result = self.run_adapter()
        self.assertNotEqual(result["sourceSha256"], result["adaptedSha256"])
        self.assertFalse(result["nativeExecutionQualified"])

    def test_changed_receipt_cannot_claim_source_or_native_qualification(self):
        for key, value in (
            ("schemaVersion", 2),
            ("classification", "other"),
            ("path", "other.ts"),
            ("callSites", 1),
            ("nativeExecutionQualified", True),
            ("sourceSha256", "0" * 64),
            ("adapterSha256", "0" * 64),
            ("adaptedSha256", "0" * 64),
        ):
            with self.subTest(field=key):
                with self.assertRaisesRegex(ValueError, "receipt is invalid"):
                    self.run_adapter({key: value})


if __name__ == "__main__":
    unittest.main()
