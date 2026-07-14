// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StateFileKeyAllowlistRestoreOwnership, StateFileUserKeyType } from "../agent/defs.js";
import { shellQuote } from "../runner.js";

export { KEY_ALLOWLIST_MERGE_PYTHON } from "./key-allowlist-merge/python-script.js";

import { KEY_ALLOWLIST_MERGE_PYTHON } from "./key-allowlist-merge/python-script.js";

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

export function stateFileKeyMergeSpec(
  ownership: StateFileKeyAllowlistRestoreOwnership,
): KeyAllowlistMergeSpec {
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

function assertSafeStateFilePath(path: string): void {
  if (path.startsWith("/") || path.split("/").some((segment) => segment === "..")) {
    throw new Error(`State file path '${path}' must be a relative path without '..' segments`);
  }
}

export function buildKeyAllowlistMergeRestoreCommand(
  dir: string,
  spec: { path: string },
  ownership: StateFileKeyAllowlistRestoreOwnership,
): string {
  assertSafeStateFilePath(spec.path);
  const normalizedDir = dir.replace(/\/+$/, "");
  const destination = shellQuote(`${normalizedDir}/${spec.path}`);
  const baseDir = shellQuote(normalizedDir);
  const relativePath = shellQuote(spec.path);
  const mergeSpec = shellQuote(JSON.stringify(stateFileKeyMergeSpec(ownership)));
  return [
    `dst=${destination}`,
    'parent="$(dirname "$dst")"',
    '[ -d "$parent" ] && [ ! -L "$parent" ] || { echo "unsafe config parent" >&2; exit 10; }',
    '[ -f "$dst" ] && [ ! -L "$dst" ] || { echo "fresh config is missing or unsafe" >&2; exit 11; }',
    `/opt/venv/bin/python3 -I -c ${shellQuote(KEY_ALLOWLIST_MERGE_PYTHON)} ${baseDir} ${relativePath} ${mergeSpec}`,
  ].join("; ");
}
