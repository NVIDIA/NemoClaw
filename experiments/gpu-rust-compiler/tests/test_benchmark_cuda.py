# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Benchmark evidence must keep CPU, GPU and process timing boundaries distinct."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from benchmark_cuda import comparisons, statistics_ms, synthetic_workloads, validate_pass


def metrics(backend, samples):
    return {"backend": backend, "repeat_outputs_equal": True, "repeats": len(samples),
            "warm_pass_end_to_end_ms": statistics_ms(samples)}


class CudaBenchmarkTests(unittest.TestCase):
    def test_workloads_cover_large_batches_and_long_dependency_chains_reproducibly(self):
        first = synthetic_workloads()
        self.assertEqual(first, synthetic_workloads())
        self.assertEqual([workload["name"] for workload in first],
                         ["tiny", "compact-batch-64", "compact-batch-512", "compact-batch",
                          "few-wide", "long-chain", "mixed-compact-and-long"])
        large = first[3]
        cells = sum(len(function["blocks"]) * ((function["value_count"] + 31) // 32)
                    for function in large["functions"])
        self.assertGreaterEqual(cells, 500_000)
        self.assertGreaterEqual(len(large["functions"]), 4000)
        chain = first[5]["functions"][0]
        self.assertEqual(chain["blocks"][0]["successors"], [1])
        self.assertEqual(chain["blocks"][-1]["successors"], [])
        self.assertEqual(chain["blocks"][-1]["use"], [0, 32, 64])

    def test_pass_rejects_wrong_output_or_incomplete_gpu_evidence(self):
        cpu = metrics("cpu-native", [1.0, 2.0, 3.0])
        validate_pass(cpu, "cpu-native", [1, 2], [1, 2], 3)
        with self.assertRaisesRegex(ValueError, "oracle"):
            validate_pass(cpu, "cpu-native", [1, 3], [1, 2], 3)
        cuda = metrics("cuda", [1.0, 2.0, 3.0])
        with self.assertRaisesRegex(ValueError, "GPU"):
            validate_pass(cuda, "cuda", [1, 2], [1, 2], 3)
        cuda.update(converged=True, device_name="test-device",
                    gpu_execution_ms=statistics_ms([0.2, 0.3, 0.4]))
        validate_pass(cuda, "cuda", [1, 2], [1, 2], 3)

    def test_comparison_keeps_input_update_and_resident_input_separate(self):
        cpu = metrics("cpu-native", [5.0, 6.0, 7.0])
        cpu["selected_variant"] = "serial"
        cuda = metrics("cuda", [1.0, 2.0, 3.0])
        cuda["warm_input_update_end_to_end_ms"] = statistics_ms([7.0, 8.0, 9.0])
        result = comparisons(cpu, cuda)
        self.assertEqual(result["cpu_selected_variant"], "serial")
        self.assertEqual(result["cpu_over_cuda_resident_input_ratio"], 3.0)
        self.assertEqual(result["cpu_over_cuda_input_update_ratio"], 0.75)
        self.assertIn("excludes host-to-device", result["resident_input_scope"])

    def test_cpu_only_records_missing_gpu_without_speedup_or_zero_time(self):
        result = comparisons(metrics("cpu-native", [1.0]), None)
        self.assertEqual(result["cuda_status"], "unavailable")
        self.assertIsNone(result["cpu_over_cuda_resident_input_ratio"])
        self.assertIsNone(result["cuda_resident_input_median_ms"])
        with self.assertRaisesRegex(ValueError, "positive"):
            statistics_ms([0.0])


if __name__ == "__main__":
    unittest.main()
