# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Portable CPU oracle correctness and native/CUDA workload-layout compatibility."""
import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from liveness_reference import solve_reference
from verify_cuda import oracle_words, workloads


def block(successors=None, use=None, definitions=None):
    return {"name": "block", "successors": successors or [],
            "use": use or [], "def": definitions or []}


def fixture():
    return {"version": 1, "functions": [{"name": "fixture", "value_count": 33,
        "blocks": [block([1], [0], [32]), block([0], [32], [0])],
        "phi_edge_uses": [{"from": 0, "to": 1, "values": [32]}]}]}


class LivenessReferenceTests(unittest.TestCase):
    def test_cyclic_cfg_and_phi_uses_are_killed_by_predecessor_definitions(self):
        result = solve_reference(fixture())
        self.assertEqual(result["live_in_words"], [1, 0, 0, 1])
        self.assertEqual(result["row_offsets"], [0, 2, 4])
        self.assertEqual(result["function_block_offsets"], [0, 2])
        self.assertEqual(result["requested_backend"], "cpu-reference")
        self.assertEqual(result["actual_gpu_functions"], 0)

    def test_multi_function_layout_zero_values_and_word_boundaries(self):
        workload = {"version": 1, "functions": [
            {"name": "zero", "value_count": 0, "blocks": [block()], "phi_edge_uses": []},
            {"name": "wide", "value_count": 33,
             "blocks": [block([1], [31]), block(use=[32])], "phi_edge_uses": []}]}
        result = solve_reference(workload)
        self.assertEqual(result["live_in_words"], [0, 1 << 31, 1, 0, 1])
        self.assertEqual(result["row_offsets"], [0, 1, 3, 5])
        self.assertEqual(result["function_block_offsets"], [0, 1, 3])

    def test_rejects_invalid_dimensions_ids_successors_and_phi_edges(self):
        cases = []
        for key, value in (("version", 2), ("version", True), ("functions", [])):
            candidate = fixture()
            candidate[key] = value
            cases.append(candidate)
        for value in (-1, True, 1_000_000):
            candidate = fixture()
            candidate["functions"][0]["value_count"] = value
            cases.append(candidate)
        candidate = fixture()
        candidate["functions"][0]["blocks"] = []
        cases.append(candidate)
        for field, values in (("use", [33]), ("def", [-1]), ("use", [True]),
                              ("successors", [2]), ("successors", [-1]), ("successors", [False])):
            candidate = fixture()
            candidate["functions"][0]["blocks"][0][field] = values
            cases.append(candidate)
        for field, value in (("from", -1), ("to", 0), ("to", 2), ("from", True), ("values", [33])):
            candidate = fixture()
            candidate["functions"][0]["phi_edge_uses"][0][field] = value
            cases.append(candidate)
        candidate = fixture()
        del candidate["functions"][0]["blocks"][0]["def"]
        cases.append(candidate)
        for index, candidate in enumerate(cases):
            with self.subTest(index=index), self.assertRaises(ValueError):
                solve_reference(candidate)

    def test_rejects_total_cell_limit_before_attempting_large_solution(self):
        function = {"value_count": 999_999, "blocks": [block()] * 1601, "phi_edge_uses": []}
        with self.assertRaisesRegex(ValueError, "100 million"):
            solve_reference({"version": 1, "functions": [function, function]})

    def test_seeded_workpacks_match_independent_oracle_and_existing_cpu_layout(self):
        total_cells = 0
        for workload in workloads():
            with self.subTest(workpack=workload["name"]):
                original = copy.deepcopy(workload)
                result = solve_reference(workload)
                self.assertEqual(workload, original)
                self.assertEqual(result["live_in_words"], oracle_words(workload))
                total_cells += len(result["live_in_words"])
        self.assertEqual(total_cells, 8538)


if __name__ == "__main__":
    unittest.main()
