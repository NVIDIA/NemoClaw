# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Native evidence must reject cached facts and missing actual GPU execution."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from verify_native_cuda import changed_facts, validate_native
from verify_cuda import oracle_words, workloads


class NativeCudaEvidenceTests(unittest.TestCase):
    def test_changed_inputs_keep_graph_shape_but_cleared_facts_require_zero_results(self):
        original = workloads()[0]
        expected = oracle_words(original)
        changed = changed_facts(original)
        cleared = changed_facts(original, erase=True)
        self.assertNotEqual(oracle_words(changed), expected)
        self.assertEqual(oracle_words(cleared), [0] * len(expected))
        self.assertEqual(original, workloads()[0])
        for old, new in zip(original["functions"], changed["functions"]):
            self.assertEqual(old["value_count"], new["value_count"])
            self.assertEqual([row["successors"] for row in old["blocks"]],
                             [row["successors"] for row in new["blocks"]])

    def test_gpu_claim_requires_native_context_device_kernel_and_transfers_evidence(self):
        response = {"analysis_ms": 1.0, "total_recurrent_ms": 1.2,
                    "cpu_pool_workers": 8, "actual_gpu_functions": 0}
        validate_native(response, [1, 2], [1, 2])
        with self.assertRaisesRegex(ValueError, "CUDA execution"):
            validate_native(response, [1, 2], [1, 2], True)
        response.update(actual_gpu_functions=3, cuda_context_creations=1,
                        capabilities={"device_name": "test"},
                        gpu_stats={"gpu_ms": 0.2, "resident_input": 0})
        validate_native(response, [1, 2], [1, 2], True)
        response["gpu_stats"].update(resident_input=1, host_to_device_ms=0.3, staging_ms=0)
        with self.assertRaisesRegex(ValueError, "hidden input transfers"):
            validate_native(response, [1, 2], [1, 2], True, True)
        response["gpu_stats"]["host_to_device_ms"] = 0
        validate_native(response, [1, 2], [1, 2], True, True)
        with self.assertRaisesRegex(ValueError, "oracle"):
            validate_native(response, [1, 3], [1, 2], True, True)


if __name__ == "__main__":
    unittest.main()
