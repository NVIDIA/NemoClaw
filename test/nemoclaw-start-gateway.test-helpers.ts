// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shell-harness helpers shared by the gateway-health and gateway serving
// watchdog suites. Both drive real functions lifted out of
// scripts/nemoclaw-start.sh, so the extraction primitives live here rather
// than being duplicated once the watchdog suite was split into its own file
// to stay inside ci/test-file-size-budget.json.

import * as fs from "node:fs";
import * as path from "node:path";

import { expect } from "vitest";

export const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
export const GATEWAY_SUPERVISOR = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "lib",
  "gateway-supervisor.sh",
);

// Read a file that may legitimately be absent without a check-then-read
// race (CodeQL js/file-system-race): attempt the read and treat a missing
// file as null.
export function readFileIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

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

export function extractGatewayLogAppendFunction(src: string, gatewayLog: string): string {
  const functionSource = extractShellFunction(src, "append_openclaw_gateway_log_line");
  const marker = '  local log_file="/tmp/gateway.log"';
  expect(functionSource).toContain(marker);
  return functionSource.replace(marker, `  local log_file=${JSON.stringify(gatewayLog)}`);
}

export function safeTmpHelpers(src: string): string {
  const start = src.indexOf("_nemoclaw_safe_replace_tmp_file() {");
  const end = src.indexOf("_START_LOG=", Math.max(start, 0));
  expect(start, "Expected safe temp helpers in scripts/nemoclaw-start.sh").not.toBe(-1);
  expect(end, "Expected safe temp helpers in scripts/nemoclaw-start.sh").toBeGreaterThan(start);
  return src.slice(start, end);
}

export function pidIdentityFunctions(src: string): string {
  const supervisor = fs.readFileSync(GATEWAY_SUPERVISOR, "utf-8");
  return [
    extractShellFunction(src, "openclaw_load_pid_identity"),
    extractShellFunction(src, "openclaw_pid_start_identity"),
    extractShellFunction(src, "capture_openclaw_pid_start_identity"),
    extractShellFunction(src, "openclaw_supervised_pid_is_live"),
    extractShellFunction(supervisor, "gateway_control_proc_root"),
    extractShellFunction(supervisor, "gateway_control_proc_root_is_explicit"),
    extractShellFunction(supervisor, "gateway_control_pid_state"),
    extractShellFunction(supervisor, "gateway_control_pid_is_live"),
  ].join("\n");
}

export const writeProcStatFunction = [
  "write_proc_stat() {",
  '  local pid="$1" parent="$2" start="$3"',
  '  printf \'%s (test-process) S %s\' "$pid" "$parent"',
  "  for _ in {1..17}; do printf ' 0'; done",
  "  printf ' %s\\n' \"$start\"",
  "}",
].join("\n");
