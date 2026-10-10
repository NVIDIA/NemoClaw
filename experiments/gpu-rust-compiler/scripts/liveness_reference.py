# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Portable independent CPU set oracle for the backend-neutral workload.

The result layout matches the native runner, including terminal offset entries.
This module executes no GPU code and reports no GPU execution.
"""


def _object(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _array(value, label):
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    return value


def _integer(value, label):
    if type(value) is not int:
        raise ValueError(f"{label} must be an integer")
    return value


def _field(mapping, key, label):
    if key not in mapping:
        raise ValueError(f"Missing {label}.{key}")
    return mapping[key]


def _ids(values, count, label):
    values = _array(values, label)
    for value in values:
        if not 0 <= _integer(value, label) < count:
            raise ValueError(f"{label} contains an out-of-range ID")
    return set(values)


def _validate(workload):
    workload = _object(workload, "workload")
    version = _integer(_field(workload, "version", "workload"), "version")
    if version != 1:
        raise ValueError("Unsupported workload version")
    functions = _array(_field(workload, "functions", "workload"), "functions")
    if not functions:
        raise ValueError("Workload has no functions")
    validated = []
    cells = 0
    for index, value in enumerate(functions):
        label = f"functions[{index}]"
        function = _object(value, label)
        value_count = _integer(_field(function, "value_count", label), f"{label}.value_count")
        blocks = _array(_field(function, "blocks", label), f"{label}.blocks")
        if not blocks or not 0 <= value_count < 1_000_000:
            raise ValueError(f"Invalid dimensions in {label}")
        width = max(1, (value_count + 31) // 32)
        cells += width * len(blocks)
        if cells > 100_000_000:
            raise ValueError("Workload exceeds 100 million bitset words")
        successors, uses, definitions = [], [], []
        for block_index, block_value in enumerate(blocks):
            block_label = f"{label}.blocks[{block_index}]"
            block = _object(block_value, block_label)
            successors.append(_ids(_field(block, "successors", block_label), len(blocks),
                                   f"{block_label}.successors"))
            uses.append(_ids(_field(block, "use", block_label), value_count, f"{block_label}.use"))
            definitions.append(_ids(_field(block, "def", block_label), value_count, f"{block_label}.def"))
        outgoing_phi = [set() for _ in blocks]
        edges = _array(_field(function, "phi_edge_uses", label), f"{label}.phi_edge_uses")
        for edge_index, edge_value in enumerate(edges):
            edge_label = f"{label}.phi_edge_uses[{edge_index}]"
            edge = _object(edge_value, edge_label)
            source = _integer(_field(edge, "from", edge_label), f"{edge_label}.from")
            target = _integer(_field(edge, "to", edge_label), f"{edge_label}.to")
            if not 0 <= source < len(blocks) or not 0 <= target < len(blocks) or target not in successors[source]:
                raise ValueError(f"Invalid phi edge in {label}")
            outgoing_phi[source].update(_ids(_field(edge, "values", edge_label), value_count,
                                             f"{edge_label}.values"))
        validated.append((width, successors, uses, definitions, outgoing_phi))
    return validated


def solve_reference(workload):
    """Validate input and return CPU-reference words with native-compatible offsets.

    The synchronous set algorithm is deliberately independent of the CUDA kernel
    and native CPU bitsets. Validation completes before solving any function.
    """
    functions = _validate(workload)
    words, row_offsets, function_offsets = [], [], []
    block_base = 0
    for width, successors, uses, definitions, outgoing_phi in functions:
        function_offsets.append(block_base)
        live = [set() for _ in successors]
        for _ in range(len(successors) + 1):
            updated = []
            for block, targets in enumerate(successors):
                out = outgoing_phi[block].union(*(live[target] for target in targets))
                updated.append(uses[block] | (out - definitions[block]))
            if updated == live:
                break
            live = updated
        else:
            raise ValueError("CPU reference fixed point did not converge")
        for values in live:
            row_offsets.append(len(words))
            row = [0] * width
            for value in values:
                row[value // 32] |= 1 << (value % 32)
            words.extend(row)
        block_base += len(successors)
    row_offsets.append(len(words))
    function_offsets.append(block_base)
    return {"live_in_words": words, "row_offsets": row_offsets,
            "function_block_offsets": function_offsets,
            "requested_backend": "cpu-reference", "actual_gpu_functions": 0}
