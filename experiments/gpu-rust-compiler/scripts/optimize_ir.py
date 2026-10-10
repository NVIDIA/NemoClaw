#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Use solved liveness to prune dead scalar SSA operations in our compiler IR.

Calls, loads, stores, phi nodes, and control flow are retained. This bounded pass
is for the new frontend's named-register LLVM output, not arbitrary LLVM files.
"""
import re
from prepare_workload import _TOKEN, _LABEL, _name, _opcode, _strip_comment

PURE = set("add sub mul and or xor shl lshr ashr icmp select trunc zext sext bitcast ptrtoint inttoptr sdiv srem".split())


def optimize(source, workload, solution):
    lines = source.splitlines(keepends=True)
    removed = set()
    function_index = -1
    block_index = -1
    instructions = []
    function = None

    def finish_block():
        nonlocal instructions
        if not instructions:
            return
        blocks = function["blocks"]
        block = blocks[block_index]
        names = function["value_names"]
        ids = {name: i for i, name in enumerate(names)}
        first = solution["function_block_offsets"][function_index]
        width = max(1, (function["value_count"] + 31) // 32)
        live = set()
        for target in block["successors"]:
            row = solution["row_offsets"][first + target]
            for value, name in enumerate(names):
                if solution["live_in_words"][row + value // 32] & (1 << (value % 32)):
                    live.add(name)
        for edge in function["phi_edge_uses"]:
            if edge["from"] == block_index:
                live.update(names[value] for value in edge["values"])
        for line_index, tokens in reversed(instructions):
            opcode, operands, definition = _opcode(tokens)
            if opcode in PURE and definition is not None and definition not in live:
                if definition.isdecimal():
                    raise ValueError("DCE requires named registers from this compiler")
                removed.add(line_index)
                continue
            if definition is not None:
                live.discard(definition)
            if opcode != "phi":
                live.update(_name(token) for token in operands if token.startswith('%') and _name(token) in ids)
        instructions = []

    for line_index, original in enumerate(lines):
        line = _strip_comment(original)
        if line.startswith("define "):
            function_index += 1
            function = workload["functions"][function_index]
            if "value_names" not in function:
                raise ValueError("Workload lacks SSA value names")
            block_index = -1
        elif function is not None and line == "}":
            finish_block()
            function = None
        elif function is not None and _LABEL.fullmatch(line):
            finish_block()
            block_index += 1
        elif function is not None and line:
            if block_index < 0:
                raise ValueError("DCE expects explicitly named blocks from this compiler")
            instructions.append((line_index, _TOKEN.findall(line)))
    if function is not None:
        raise ValueError("Unterminated compiler IR")
    return ''.join(line for i, line in enumerate(lines) if i not in removed), len(removed)
