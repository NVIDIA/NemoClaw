#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Export the backend-neutral liveness pack to the CUDA CLI's GLC1 format."""
import argparse
import json
import struct
from pathlib import Path


def pack(workload):
    if workload.get("version") != 1:
        raise ValueError("Unsupported workload version")
    groups, successor_offsets, successors = [], [0], []
    uses, defs, phi = [], [], []
    block_base = 0
    maximum = 0
    for function in workload["functions"]:
        count = len(function["blocks"])
        if count == 0 or function["value_count"] < 0:
            raise ValueError("Invalid function dimensions")
        width = max(1, (function["value_count"] + 31) // 32)
        row_base = len(uses)
        maximum = max(maximum, count)
        groups.extend((block_base, count, row_base, width, word) for word in range(width))
        for block in function["blocks"]:
            row_use, row_def = [0] * width, [0] * width
            for key, row in (("use", row_use), ("def", row_def)):
                for value in block[key]:
                    if not 0 <= value < function["value_count"]:
                        raise ValueError("Invalid local value")
                    row[value // 32] |= 1 << (value % 32)
            uses.extend(row_use); defs.extend(row_def); phi.extend([0] * width)
            for target in block["successors"]:
                if not 0 <= target < count:
                    raise ValueError("Invalid CFG successor")
                successors.append(block_base + target)
            successor_offsets.append(len(successors))
        for edge in function["phi_edge_uses"]:
            if not 0 <= edge["from"] < count or edge["to"] not in function["blocks"][edge["from"]]["successors"]:
                raise ValueError("Invalid phi edge")
            for value in edge["values"]:
                if not 0 <= value < function["value_count"]:
                    raise ValueError("Invalid phi value")
                phi[row_base + edge["from"] * width + value // 32] |= 1 << (value % 32)
        block_base += count
    integers = [len(workload["functions"]), block_base, len(uses), len(groups), maximum, len(successors)]
    integers.extend(value for group in groups for value in group)
    integers += successor_offsets + successors + uses + defs + phi
    return b"GLC1" + struct.pack(f"<{len(integers)}I", *integers)


def read_result(path):
    data = Path(path).read_bytes()
    if len(data) < 8 or data[:4] != b"GLR1":
        raise ValueError("Invalid CUDA result header")
    cells, = struct.unpack_from("<I", data, 4)
    if len(data) != 8 + cells * 4:
        raise ValueError("Invalid CUDA result length")
    return list(struct.unpack_from(f"<{cells}I", data, 8))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(pack(json.loads(args.input.read_text())))
    print(f"CUDA input: {args.output} ({args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
