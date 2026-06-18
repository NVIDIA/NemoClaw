#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0

#

"""
Validate cuTile.jl (Julia) kernel file for common translation mistakes.

Usage: python validate_cutile_jl.py <path_to_julia_file.jl>

Checks for anti-patterns that indicate incomplete or incorrect
Python cuTile → Julia cuTile.jl conversion.
"""

import re
import sys
from pathlib import Path


def validate(filepath: str) -> list[str]:
    """Return list of validation errors."""
    errors = []
    content = Path(filepath).read_text()
    lines = content.splitlines()

    # --- Import checks ---
    if "import cuTile as ct" not in content:
        errors.append("WARNING: Missing 'import cuTile as ct'")
    if "using CUDA" not in content:
        errors.append("WARNING: Missing 'using CUDA'")
    if "import cuda.tile" in content:
        errors.append("ERROR: Python import found — use 'import cuTile as ct'")

    # --- Identify kernel function bodies (between 'function' and 'end') ---
    # We look for functions that take ct.TileArray parameters
    kernel_pattern = re.compile(
        r"^function\s+\w+\(.*ct\.TileArray.*?\).*?$",
        re.MULTILINE,
    )
    kernel_starts = [m.start() for m in kernel_pattern.finditer(content)]

    # Check kernel functions have return
    for start in kernel_starts:
        # Find matching end
        depth = 1
        pos = content.index("\n", start) + 1
        while depth > 0 and pos < len(content):
            line = ""
            end_pos = content.find("\n", pos)
            if end_pos == -1:
                line = content[pos:]
                end_pos = len(content)
            else:
                line = content[pos:end_pos]
            stripped = line.strip()
            # Count depth changes
            if re.match(r"^(function|if|while|for|let|begin|do|try|quote)\b", stripped):
                depth += 1
            if stripped == "end" or stripped.startswith("end ") or stripped.startswith("end#"):
                depth -= 1
            if depth == 0:
                # Check the few lines before 'end' for return
                block = content[start:end_pos]
                if "return" not in block:
                    func_name = re.search(r"function\s+(\w+)", content[start:])
                    name = func_name.group(1) if func_name else "unknown"
                    errors.append(f"ERROR: Kernel '{name}' missing 'return' statement")
                break
            pos = end_pos + 1

    # --- Anti-pattern checks (line by line) ---
    in_kernel = False
    kernel_depth = 0

    for i, line in enumerate(lines, 1):
        stripped = line.strip()

        # Track if we're inside a kernel function
        if re.match(r"^function\s+\w+\(.*ct\.TileArray", stripped):
            in_kernel = True
            kernel_depth = 1
        elif in_kernel:
            if re.match(r"^(function|if|while|for|let|begin|do|try|quote)\b", stripped):
                kernel_depth += 1
            if stripped == "end" or stripped.startswith("end "):
                kernel_depth -= 1
                if kernel_depth == 0:
                    in_kernel = False

        # Skip comments
        if stripped.startswith("#"):
            continue

        # --- Checks that apply inside kernel bodies ---
        if in_kernel:
            # 0-based ct.bid / ct.num_blocks
            if re.search(r"ct\.bid\(0\)", line):
                errors.append(f"ERROR (line {i}): ct.bid(0) — Julia is 1-indexed, use ct.bid(1)")
            if re.search(r"ct\.num_blocks\(0\)", line):
                errors.append(f"ERROR (line {i}): ct.num_blocks(0) — Julia is 1-indexed, use ct.num_blocks(1)")

            # ct.mma (should be muladd)
            if re.search(r"ct\.mma\(", line):
                errors.append(f"ERROR (line {i}): ct.mma() — use muladd(a, b, acc) in Julia")

            # ct.matmul (should be *)
            if re.search(r"ct\.matmul\(", line):
                errors.append(f"ERROR (line {i}): ct.matmul() — use a * b in Julia")

            # ct.where (should be ifelse.)
            if re.search(r"ct\.where\(", line):
                errors.append(f"ERROR (line {i}): ct.where() — use ifelse.(cond, x, y) in Julia")

            # .astype( (Python pattern)
            if re.search(r"\.astype\(", line):
                errors.append(f"ERROR (line {i}): .astype() — use convert(ct.Tile{{T}}, tile) in Julia")

            # max(a, b) without dot (should be max.(a, b))
            # Only flag if it looks like two tile arguments, not max(tile; dims=...)
            if re.search(r"\bmax\([^;)]+,[^;)]+\)", line) and "dims" not in line:
                errors.append(f"WARNING (line {i}): max(a, b) — use max.(a, b) for element-wise max on tiles")
            if re.search(r"\bmin\([^;)]+,[^;)]+\)", line) and "dims" not in line:
                errors.append(f"WARNING (line {i}): min(a, b) — use min.(a, b) for element-wise min on tiles")

        # --- Checks that apply everywhere ---

        # Python-style type names
        if re.search(r"\bct\.float32\b", line):
            errors.append(f"ERROR (line {i}): ct.float32 — use Float32 in Julia")
        if re.search(r"\bct\.float16\b", line):
            errors.append(f"ERROR (line {i}): ct.float16 — use Float16 in Julia")
        if re.search(r"\bct\.int32\b", line):
            errors.append(f"ERROR (line {i}): ct.int32 — use Int32 in Julia")
        if re.search(r"\bct\.bfloat16\b", line):
            errors.append(f"ERROR (line {i}): ct.bfloat16 — use BFloat16 in Julia")

        # ct.cdiv (should be cld)
        if re.search(r"ct\.cdiv\(", line):
            errors.append(f"WARNING (line {i}): ct.cdiv() — use cld(a, b) in Julia")

        # Lambda grid
        if re.search(r"grid\s*=\s*\(?\s*lambda", line):
            errors.append(f"ERROR (line {i}): Lambda grid — use integer or tuple grid")

        # Python decorator
        if re.search(r"^@ct\.kernel", stripped):
            errors.append(f"ERROR (line {i}): @ct.kernel decorator — Julia kernels are plain functions")

        # ct.Constant[ in signature (should be at launch)
        if re.search(r"ct\.Constant\[", line):
            errors.append(f"ERROR (line {i}): ct.Constant[...] in signature — use ::Int and ct.Constant(val) at launch")

        # PaddingMode case
        if re.search(r"ct\.PaddingMode\.ZERO\b", line):
            errors.append(f"ERROR (line {i}): ct.PaddingMode.ZERO — use ct.PaddingMode.Zero")
        if re.search(r"ct\.PaddingMode\.NAN\b", line):
            errors.append(f"ERROR (line {i}): ct.PaddingMode.NAN — use ct.PaddingMode.Nan")

        # MemoryOrder case
        if re.search(r"ct\.MemoryOrder\.ACQUIRE\b", line):
            errors.append(f"ERROR (line {i}): ct.MemoryOrder.ACQUIRE — use ct.MemoryOrder.Acquire")
        if re.search(r"ct\.MemoryOrder\.RELEASE\b", line):
            errors.append(f"ERROR (line {i}): ct.MemoryOrder.RELEASE — use ct.MemoryOrder.Release")

        # rsqrt.(tile) is valid — cuTile.jl exports rsqrt, so broadcast dot works.
        # No longer flagged as an error.

        # Python-style launch with stream argument
        if re.search(r"ct\.launch\([^,]+,\s*stream", line) or re.search(r"ct\.launch\(\s*stream", line):
            errors.append(f"ERROR (line {i}): ct.launch(stream, ...) — Julia ct.launch does not take a stream argument")

        # ct.ones (wrong namespace — use Base overlay ones(T, dims...))
        if re.search(r"\bct\.ones\(", line):
            errors.append(f"ERROR (line {i}): ct.ones() not available — use ones(T, dims...)")

        # ct.full (not available in cuTile.jl)
        if re.search(r"\bct\.full\(", line):
            errors.append(
                f"ERROR (line {i}): ct.full() not available — use fill(val, shape), zeros(T, dims...), or ones(T, dims...)"
            )

        # ct.zeros (wrong namespace — use Base overlay zeros(T, dims...))
        if re.search(r"\bct\.zeros\(", line):
            errors.append(f"ERROR (line {i}): ct.zeros() not available — use zeros(T, dims...)")

    return errors


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python validate_cutile_jl.py <path_to_julia_file.jl>")
        sys.exit(1)

    filepath = sys.argv[1]
    if not Path(filepath).exists():
        print(f"File not found: {filepath}")
        sys.exit(1)

    errors = validate(filepath)
    if errors:
        for e in errors:
            print(e)
        sys.exit(1 if any("ERROR" in e for e in errors) else 0)
    else:
        print("OK: No issues found")
        sys.exit(0)
