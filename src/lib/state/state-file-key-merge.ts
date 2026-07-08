// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StateFileRestoreOwnership, StateFileUserKeyType } from "../agent/defs.js";
import { shellQuote } from "../runner.js";

export const KEY_ALLOWLIST_MERGE_PYTHON = String.raw`
import copy
import json
import os
import stat
import sys
import tomllib
import tomli_w

MAX_CONFIG_BYTES = 16 * 1024 * 1024


def fail(message):
    raise SystemExit(message)


def read_regular_file(path, label):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        fail(f"{label} config is missing or unsafe")
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            fail(f"{label} config is not a single regular file")
        if metadata.st_size > MAX_CONFIG_BYTES:
            fail(f"{label} config exceeds the restore size limit")
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_CONFIG_BYTES:
                fail(f"{label} config exceeds the restore size limit")
            chunks.append(chunk)
    finally:
        os.close(fd)
    try:
        text = b"".join(chunks).decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{label} config is not valid UTF-8")
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        fail(f"{label} config is not valid TOML")
    if not isinstance(parsed, dict):
        fail(f"{label} config must be a TOML document")
    return text, parsed, metadata


def load_spec(raw):
    try:
        spec = json.loads(raw)
    except (TypeError, ValueError):
        fail("restore ownership spec is not valid JSON")
    if not isinstance(spec, dict):
        fail("restore ownership spec must be an object")
    return spec


def preserved_headers(text, required_headers):
    lines = text.splitlines()
    header_lines = []
    for line in lines:
        if line.startswith("#"):
            header_lines.append(line)
        else:
            break
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
        if len(line) > 2048 or any(ord(char) < 32 for char in line):
            fail("current config has unsafe generated header metadata")
    return header_lines[: len(required_headers)]


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
        return value in spec.get("values", [])
    return False


def set_path(root, path, value):
    node = root
    for segment in path[:-1]:
        child = node.get(segment)
        if not isinstance(child, dict):
            child = {}
            node[segment] = child
        node = child
    node[path[-1]] = value


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


def render_merged_config(merged, header_lines):
    try:
        rendered = tomli_w.dumps(merged)
    except Exception:
        fail("merged config could not be serialized safely")
    if not isinstance(rendered, str):
        fail("merged config serializer returned invalid output")
    if header_lines:
        text = "\n".join(header_lines) + "\n\n" + rendered.rstrip() + "\n"
    else:
        text = rendered.rstrip() + "\n"
    payload = text.encode("utf-8")
    if len(payload) > MAX_CONFIG_BYTES:
        fail("merged config exceeds the restore size limit")
    return payload


def write_staged_and_replace(staged_path, current_path, current_metadata, payload):
    if os.path.dirname(staged_path) != os.path.dirname(current_path):
        fail("config staging path must share the live config directory")
    flags = os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(staged_path, flags)
    except OSError:
        fail("config staging file is missing or unsafe")
    try:
        staged_metadata = os.fstat(fd)
        if not stat.S_ISREG(staged_metadata.st_mode) or staged_metadata.st_nlink != 1:
            fail("config staging file is not a single regular file")
        written = 0
        while written < len(payload):
            written += os.write(fd, payload[written:])
        os.fchmod(fd, 0o660)
        os.fsync(fd)
    finally:
        os.close(fd)

    try:
        latest = os.lstat(current_path)
    except OSError:
        fail("current config changed before atomic restore")
    if stat.S_ISLNK(latest.st_mode) or (
        latest.st_dev,
        latest.st_ino,
    ) != (
        current_metadata.st_dev,
        current_metadata.st_ino,
    ):
        fail("current config changed before atomic restore")

    os.replace(staged_path, current_path)
    directory_fd = os.open(os.path.dirname(current_path), os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def main():
    if len(sys.argv) != 5:
        fail("expected backup, current, staging paths, and an ownership spec")
    backup_path, current_path, staged_path, spec_raw = sys.argv[1:]
    spec = load_spec(spec_raw)
    _backup_text, backup, _backup_metadata = read_regular_file(backup_path, "backed-up")
    current_text, current, current_metadata = read_regular_file(current_path, "current")
    header_lines = preserved_headers(current_text, spec.get("require_fresh_headers", []))
    assert_fresh_tables(current, spec.get("require_fresh_tables", []))
    merged = merge_user_keys(backup, current, spec.get("user_keys", []))
    payload = render_merged_config(merged, header_lines)
    write_staged_and_replace(staged_path, current_path, current_metadata, payload)


main()
`.trim();

interface PythonUserKey {
  path: string[];
  type: StateFileUserKeyType;
  values?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  max_length?: number;
}

export interface KeyAllowlistMergeSpec {
  user_keys: PythonUserKey[];
  require_fresh_tables: string[][];
  require_fresh_headers: { match: "exact" | "prefix"; value: string }[];
}

export function stateFileKeyMergeSpec(ownership: StateFileRestoreOwnership): KeyAllowlistMergeSpec {
  return {
    user_keys: (ownership.userKeys ?? []).map((key) => {
      const spec: PythonUserKey = { path: key.key.split("."), type: key.type };
      if (key.type === "enum" && key.values) spec.values = key.values;
      if (key.type === "integer" || key.type === "number") {
        if (key.min !== undefined) spec.min = key.min;
        if (key.max !== undefined) spec.max = key.max;
      }
      if (key.type === "string" && key.maxLength !== undefined) spec.max_length = key.maxLength;
      return spec;
    }),
    require_fresh_tables: (ownership.requireFreshTables ?? []).map((table) => table.split(".")),
    require_fresh_headers: (ownership.requireFreshHeaders ?? []).map((header) => ({
      match: header.match,
      value: header.value,
    })),
  };
}

export function buildKeyAllowlistMergeRestoreCommand(
  dir: string,
  spec: { path: string },
  ownership: StateFileRestoreOwnership,
): string {
  const normalizedDir = dir.replace(/\/+$/, "");
  const destination = shellQuote(`${normalizedDir}/${spec.path}`);
  const mergeSpec = shellQuote(JSON.stringify(stateFileKeyMergeSpec(ownership)));
  return [
    `dst=${destination}`,
    'parent="$(dirname "$dst")"',
    '[ -d "$parent" ] && [ ! -L "$parent" ] || { echo "unsafe config parent" >&2; exit 10; }',
    '[ -f "$dst" ] && [ ! -L "$dst" ] || { echo "fresh config is missing or unsafe" >&2; exit 11; }',
    'backup_tmp="$(mktemp "${parent}/.nemoclaw-restore-backup.XXXXXX")"',
    'staged_tmp="$(mktemp "${parent}/.nemoclaw-restore-merged.XXXXXX")"',
    'trap \'rm -f -- "$backup_tmp" "$staged_tmp"\' EXIT',
    'cat > "$backup_tmp"',
    'chmod 600 "$backup_tmp" "$staged_tmp"',
    `/opt/venv/bin/python3 -I -c ${shellQuote(KEY_ALLOWLIST_MERGE_PYTHON)} "$backup_tmp" "$dst" "$staged_tmp" ${mergeSpec}`,
  ].join("; ");
}
