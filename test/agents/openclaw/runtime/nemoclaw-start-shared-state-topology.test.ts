// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(process.cwd(), "scripts", "nemoclaw-start.sh");

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `Expected ${startMarker} in nemoclaw-start.sh`).toBeGreaterThanOrEqual(0);
  expect(end, `Expected ${endMarker} after ${startMarker} in nemoclaw-start.sh`).toBeGreaterThan(
    start,
  );
  return source.slice(start, end);
}

function runBash(lines: string[]): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-c", ["set -euo pipefail", ...lines].join("\n")], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

describe("nemoclaw-start shared-state topology (#7280)", () => {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");

  it.each([
    { expected: "1", initial: "caller-disabled", uid: 0 },
    { expected: "unset", initial: "1", uid: 1000 },
  ])("derives marker $expected for uid $uid", ({ expected, initial, uid }) => {
    const block = sourceBlock(
      source,
      "# OpenClaw 2026.7.1 enforces owner-only SQLite",
      "# Begin the root PID 1 readiness lease",
    );
    const result = runBash([
      `id() { if [ "\${1:-}" = "-u" ]; then printf ${JSON.stringify(String(uid))}; else command id "$@"; fi; }`,
      `export NEMOCLAW_OPENCLAW_SHARED_STATE=${JSON.stringify(initial)}`,
      block,
      'printf "%s\\n" "${NEMOCLAW_OPENCLAW_SHARED_STATE:-unset}"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it.each([
    { expected: "export NEMOCLAW_OPENCLAW_SHARED_STATE=1", marker: "1" },
    { expected: "unset NEMOCLAW_OPENCLAW_SHARED_STATE", marker: "" },
  ])("writes connect-shell command: $expected", ({ expected, marker }) => {
    const block = sourceBlock(
      source,
      '    if [ "${NEMOCLAW_OPENCLAW_SHARED_STATE:-}" = "1" ]; then',
      '    if [ -n "${OPENCLAW_GATEWAY_PORT:-}" ]; then',
    );
    const markerCommand = marker
      ? "export NEMOCLAW_OPENCLAW_SHARED_STATE=1"
      : "unset NEMOCLAW_OPENCLAW_SHARED_STATE";
    const result = runBash([markerCommand, block]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });
});
