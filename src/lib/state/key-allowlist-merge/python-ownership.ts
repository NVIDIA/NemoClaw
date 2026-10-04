// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Python helpers that validate managed data and copy only manifest-owned user values. */
export const KEY_ALLOWLIST_OWNERSHIP_PYTHON = String.raw`
def preserved_headers(text, required_headers):
    lines = text.splitlines()
    header_lines = []
    for line in lines:
        if line.startswith("#"):
            header_lines.append(line)
        else:
            break
    for line in header_lines:
        if len(line) > 2048 or any(ord(char) < 32 for char in line):
            fail("current config has unsafe generated header metadata")
    for index, required in enumerate(required_headers):
        if index >= len(header_lines):
            fail("current config is missing a required generated header line")
        line = header_lines[index]
        value = required.get("value", "")
        if required.get("match") == "prefix":
            if not line.startswith(value):
                fail("current config generated header is missing a required prefix")
        elif line != value:
            fail("current config generated header does not match")
    return header_lines


def resolve(node, path):
    for segment in path:
        if not isinstance(node, dict) or segment not in node:
            return False, None
        node = node[segment]
    return True, node


def assert_fresh_tables(current, tables):
    for path in tables:
        found, value = resolve(current, path)
        if not found or not isinstance(value, dict):
            fail(f"current config is missing managed [{'.'.join(path)}] data")


def value_allowed(spec, value):
    kind = spec.get("type")
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        if not isinstance(value, int) or isinstance(value, bool):
            return False
        if "min" in spec and value < spec["min"]:
            return False
        if "max" in spec and value > spec["max"]:
            return False
        return True
    if kind == "number":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        if not math.isfinite(value):
            return False
        if "min" in spec and value < spec["min"]:
            return False
        if "max" in spec and value > spec["max"]:
            return False
        return True
    if kind == "string":
        if not isinstance(value, str):
            return False
        if "max_length" in spec and len(value) > spec["max_length"]:
            return False
        return True
    if kind == "enum":
        return any(type(value) is type(candidate) and value == candidate for candidate in spec.get("values", []))
    return False


def set_path(root, path, value):
    node = root
    for segment in path[:-1]:
        child = node.get(segment)
        if child is None:
            child = {}
            node[segment] = child
        elif not isinstance(child, dict):
            return False
        node = child
    node[path[-1]] = value
    return True


def merge_user_keys(backup, current, user_keys):
    merged = copy.deepcopy(current)
    for spec in user_keys:
        path = spec.get("path", [])
        if not path:
            continue
        found, value = resolve(backup, path)
        if not found or not value_allowed(spec, value):
            continue
        set_path(merged, path, copy.deepcopy(value))
    return merged
`.trim();
