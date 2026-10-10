#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Extract an explicit SSA block-liveness workload from textual LLVM IR.

This is a deliberately bounded parser, not an LLVM implementation. Unsupported
opcodes, unresolved locals, missing terminators and ambiguous names fail closed.
Phi operands are edge uses; folding them into GEN must apply predecessor DEF.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
from pathlib import Path


class IRParseError(ValueError):
    pass


_NAME = r'(?:"(?:[^"\\]|\\.)*"|[-a-zA-Z$._0-9]+)'
_LOCAL = re.compile(r'%' + _NAME)
_TOKEN = re.compile(r'[%@]' + _NAME + r'|"(?:[^"\\]|\\.)*"|[-a-zA-Z$._0-9]+|[^\s]')
_LABEL = re.compile(r'^(' + _NAME + r')\s*:$')
_TYPE = re.compile(r'^%(' + _NAME + r')\s*=\s*type\b')
_OPS = set("""add fadd sub fsub mul fmul udiv sdiv fdiv urem srem frem
    shl lshr ashr and or xor fneg icmp fcmp select freeze trunc zext sext
    fptrunc fpext fptoui fptosi uitofp sitofp ptrtoint inttoptr bitcast
    addrspacecast extractelement insertelement shufflevector extractvalue
    insertvalue alloca load store fence cmpxchg atomicrmw getelementptr
    phi call invoke callbr va_arg landingpad catchpad cleanuppad catchswitch
    ret br switch indirectbr resume catchret cleanupret unreachable""".split())
_TERMINATORS = set("ret br switch indirectbr invoke callbr resume catchret cleanupret catchswitch unreachable".split())


def _name(token: str) -> str:
    token = token.lstrip('%@')
    if token.startswith('"'):
        token = token[1:-1]
        token = re.sub(r'\\([0-9A-Fa-f]{2})', lambda m: chr(int(m[1], 16)), token)
    return token


def _strip_comment(line: str) -> str:
    quoted = False
    escaped = False
    for i, ch in enumerate(line):
        if quoted and ch == "\\" and not escaped:
            escaped = True
            continue
        if ch == '"' and not escaped:
            quoted = not quoted
        if ch == ';' and not quoted:
            return line[:i].strip()
        escaped = False
    return line.strip()


def _balance(text: str) -> int:
    return sum(t in ('[', '(', '{') for t in _TOKEN.findall(text)) - sum(
        t in (']', ')', '}') for t in _TOKEN.findall(text)
    )


def _split_top(tokens: list[str], separator: str = ',') -> list[list[str]]:
    result, current, depth = [], [], 0
    for token in tokens:
        if token == separator and depth == 0:
            result.append(current)
            current = []
            continue
        current.append(token)
        depth += token in ('[', '(', '{', '<')
        depth -= token in (']', ')', '}', '>')
    result.append(current)
    return result


def _opcode(tokens: list[str]) -> tuple[str, list[str], str | None]:
    definition = None
    if len(tokens) > 2 and tokens[0].startswith('%') and tokens[1] == '=':
        definition, tokens = _name(tokens[0]), tokens[2:]
    if tokens and tokens[0] in ('tail', 'musttail', 'notail'):
        tokens = tokens[1:]
    if not tokens or tokens[0] not in _OPS:
        raise IRParseError(f"unsupported instruction: {' '.join(tokens[:10])}")
    return tokens[0], tokens[1:], definition


def _function_header(header: str, named_types: set[str]) -> tuple[str, list[str], str]:
    tokens = _TOKEN.findall(header)
    try:
        gi = next(i for i, t in enumerate(tokens) if t.startswith('@'))
    except StopIteration as exc:
        raise IRParseError('function definition has no global name') from exc
    if tokens[gi + 1] != '(':
        raise IRParseError('function arguments must follow its name')
    depth, end = 1, gi + 2
    while end < len(tokens) and depth:
        depth += tokens[end] == '('
        depth -= tokens[end] == ')'
        end += 1
    if depth:
        raise IRParseError('unterminated function arguments')
    args, next_unnamed = [], 0
    for arg in _split_top(tokens[gi + 2:end - 1]):
        if not arg or arg == ['...']:
            continue
        locals_ = [t for t in arg if t.startswith('%')]
        # LLVM printers name arguments; support omitted argument names as well.
        if locals_ and _name(locals_[-1]) not in named_types:
            name = _name(locals_[-1])
        elif locals_ and len(locals_) > 1:
            raise IRParseError('argument name collides with a named LLVM type')
        else:
            name = str(next_unnamed)
        if name.isdecimal():
            next_unnamed = max(next_unnamed, int(name) + 1)
        args.append(name)
    return _name(tokens[gi]), args, str(next_unnamed)


def _parse_function(header: str, lines: list[str], named_types: set[str]) -> dict:
    fname, args, implicit_entry = _function_header(header, named_types)
    blocks: list[dict] = []
    pending = ''

    def finish_instruction() -> None:
        nonlocal pending
        if pending:
            if not blocks:
                blocks.append({'name': implicit_entry, 'instructions': []})
            # Debug records do not represent executable operand uses.
            if not pending.startswith('#dbg_'):
                blocks[-1]['instructions'].append(_TOKEN.findall(pending))
            pending = ''

    for line in lines:
        label = _LABEL.fullmatch(line)
        if label:
            finish_instruction()
            blocks.append({'name': _name(label[1]), 'instructions': []})
            continue
        continuation = line == 'cleanup' or line.startswith(('to label ', 'unwind label ', 'catch ', 'filter '))
        if pending and (_balance(pending) > 0 or continuation):
            pending += ' ' + line
        else:
            finish_instruction()
            pending = line
    finish_instruction()
    if not blocks:
        raise IRParseError(f'{fname}: function body is empty')
    block_ids = {b['name']: i for i, b in enumerate(blocks)}
    if len(block_ids) != len(blocks):
        raise IRParseError(f'{fname}: duplicate block name')
    values: dict[str, int] = {}
    for arg in args:
        if arg in values:
            raise IRParseError(f'{fname}: duplicate argument {arg}')
        values[arg] = len(values)
    parsed = []
    for block in blocks:
        instructions = [_opcode(t) for t in block['instructions']]
        if not instructions or instructions[-1][0] not in _TERMINATORS:
            raise IRParseError(f"{fname}/{block['name']}: missing terminator")
        if any(op in _TERMINATORS for op, _, _ in instructions[:-1]):
            raise IRParseError(f"{fname}/{block['name']}: instruction after terminator")
        for _, _, definition in instructions:
            if definition is not None:
                if definition in values or definition in block_ids:
                    raise IRParseError(f'{fname}: duplicate local definition {definition}')
                values[definition] = len(values)
        parsed.append(instructions)
    if set(values) & named_types:
        raise IRParseError(f'{fname}: local value collides with named LLVM type')

    def local_uses(tokens: list[str], labels: bool = True) -> set[int]:
        uses = set()
        for i, token in enumerate(tokens):
            if not token.startswith('%'):
                continue
            name = _name(token)
            if name in named_types or (labels and i and tokens[i - 1] == 'label'):
                continue
            if name not in values:
                raise IRParseError(f'{fname}: unresolved local value %{name}')
            uses.add(values[name])
        return uses

    edge_uses: dict[tuple[int, int], set[int]] = {}
    result_blocks = []
    for bi, (block, instructions) in enumerate(zip(blocks, parsed)):
        defs, uses, successors = set(), set(), []
        seen_non_phi = False
        for op, operands, definition in instructions:
            if op == 'phi':
                if seen_non_phi or definition is None:
                    raise IRParseError(f"{fname}/{block['name']}: invalid phi placement")
                # Top-level incoming pairs, including array/vector constant operands.
                incoming = [part for part in _split_top(operands) if part and part[-1] == ']']
                if not incoming:
                    raise IRParseError(f'{fname}: phi has no incoming pairs')
                for part in incoming:
                    # The type itself can be an array, so match the final pair
                    # backwards rather than assuming the first '[' starts it.
                    depth, start = 0, None
                    for j in range(len(part) - 1, -1, -1):
                        depth += part[j] == ']'
                        depth -= part[j] == '['
                        if depth == 0:
                            start = j
                            break
                    if start is None or part[start] != '[':
                        raise IRParseError(f'{fname}: malformed phi incoming brackets')
                    pair = _split_top(part[start + 1:-1])
                    if len(pair) != 2 or len(pair[1]) != 1 or not pair[1][0].startswith('%'):
                        raise IRParseError(f'{fname}: unsupported phi incoming pair')
                    pred = _name(pair[1][0])
                    if pred not in block_ids:
                        raise IRParseError(f'{fname}: phi references unknown predecessor {pred}')
                    edge_uses.setdefault((block_ids[pred], bi), set()).update(local_uses(pair[0]))
            else:
                seen_non_phi = True
                is_debug_intrinsic = op == 'call' and any(t.startswith('@llvm.dbg.') for t in operands)
                if not is_debug_intrinsic:
                    uses.update(local_uses(operands) - defs)
            if definition is not None:
                defs.add(values[definition])
            if op in _TERMINATORS:
                for i, token in enumerate(operands[:-1]):
                    if token == 'label':
                        target = _name(operands[i + 1])
                        if target not in block_ids:
                            raise IRParseError(f'{fname}: unknown CFG target {target}')
                        if block_ids[target] not in successors:
                            successors.append(block_ids[target])
                if op == 'br' and len(successors) not in (1, 2):
                    raise IRParseError(f'{fname}: unsupported branch CFG')
                if op in ('switch', 'invoke', 'callbr', 'indirectbr', 'catchret') and not successors:
                    raise IRParseError(f'{fname}: terminator has no CFG targets')
        result_blocks.append({'name': block['name'], 'successors': successors,
                              'use': sorted(uses), 'def': sorted(defs)})
    for (pred, succ) in edge_uses:
        if succ not in result_blocks[pred]['successors']:
            raise IRParseError(f'{fname}: phi incoming block is not a CFG predecessor')
    return {'name': fname, 'blocks': result_blocks, 'value_count': len(values), 'value_names': list(values),
            'phi_edge_uses': [{'from': pred, 'to': succ, 'values': sorted(v)}
                              for (pred, succ), v in sorted(edge_uses.items())]}


def parse_llvm_ir(source: str, name: str = 'llvm-ir') -> dict:
    lines = [_strip_comment(line) for line in source.splitlines()]
    lines = [line for line in lines if line]
    named_types = {_name(m[1]) for line in lines if (m := _TYPE.match(line))}
    functions, i = [], 0
    while i < len(lines):
        if not lines[i].startswith('define '):
            i += 1
            continue
        header = lines[i]
        while not header.endswith('{'):
            i += 1
            if i >= len(lines):
                raise IRParseError('unterminated function header')
            header += ' ' + lines[i]
        i += 1
        body = []
        while i < len(lines) and lines[i] != '}':
            body.append(lines[i])
            i += 1
        if i == len(lines):
            raise IRParseError('unterminated function body')
        try:
            functions.append(_parse_function(header, body, named_types))
        except IRParseError as exc:
            raise IRParseError(f'function starting with {header[:100]}: {exc}') from exc
        i += 1
    if not functions:
        raise IRParseError('no defined functions found in LLVM IR')
    return {'version': 1, 'name': name, 'functions': functions}


def fold_phi_edge_uses(function: dict) -> dict:
    """Make GEN suitable for IN=GEN | (union successor IN & ~DEF).

    Keep explicit edge uses for constructing OUT or checking edge semantics.
    A phi operand defined in the predecessor is live out but never live in.
    """
    folded = copy.deepcopy(function)
    for edge in function['phi_edge_uses']:
        block = folded['blocks'][edge['from']]
        block['use'] = sorted(set(block['use']) | (set(edge['values']) - set(block['def'])))
    return folded


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', nargs='+', type=Path)
    parser.add_argument('--output', '-o', required=True, type=Path)
    parser.add_argument('--name', default='rustc-llvm-ir')
    args = parser.parse_args()
    workload = {'version': 1, 'name': args.name, 'functions': []}
    try:
        for path in args.inputs:
            workload['functions'].extend(parse_llvm_ir(path.read_text(), str(path))['functions'])
    except (IRParseError, OSError) as exc:
        parser.exit(2, f'workload extraction failed: {exc}\n')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(workload, indent=2) + '\n')
    print(f"Extracted {len(workload['functions'])} functions into {args.output}")


if __name__ == '__main__':
    main()
