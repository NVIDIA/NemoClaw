// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shell-harness helpers shared by gateway process and log tests. They drive
// real functions lifted out of the production scripts.

import * as path from "node:path";

import { expect } from "vitest";

export const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

export function extractShellFunction(src: string, name: string): string {
  const header = `${name}() {`;
  const start = src.indexOf(header);
  expect(start, `Expected ${name} in scripts/nemoclaw-start.sh`).not.toBe(-1);
  const bodyStart = start + header.length;
  const body = src.slice(bodyStart);
  const closing = body.match(/^}$/m);
  expect(closing, `Expected closing brace for ${name} in scripts/nemoclaw-start.sh`).not.toBeNull();
  return `${name}() {${body.slice(0, closing?.index ?? 0)}\n}`;
}

export function safeTmpHelpers(src: string): string {
  const start = src.indexOf("_nemoclaw_safe_replace_tmp_file() {");
  const end = src.indexOf("_START_LOG=", Math.max(start, 0));
  expect(start, "Expected safe temp helpers in scripts/nemoclaw-start.sh").not.toBe(-1);
  expect(end, "Expected safe temp helpers in scripts/nemoclaw-start.sh").toBeGreaterThan(start);
  return src.slice(start, end);
}

export const writeProcStatFunction = [
  "write_proc_stat() {",
  '  local pid="$1" parent="$2" start="$3"',
  '  printf \'%s (test-process) S %s\' "$pid" "$parent"',
  "  for _ in {1..17}; do printf ' 0'; done",
  "  printf ' %s\\n' \"$start\"",
  "}",
].join("\n");
