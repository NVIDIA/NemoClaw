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

  it("pins SQLite temporary files inside owner-only OpenClaw state for OpenShell", () => {
    const block = sourceBlock(
      source,
      "prepare_openshell_sqlite_tmpdir() {",
      "# ── Main ─────────────────────────────────────────────────────────",
    );
    const tmp = fs.mkdtempSync(path.join(process.cwd(), ".tmp-openclaw-sqlite-"));
    const sqliteTmp = path.join(tmp, "state", "tmp");
    try {
      const result = runBash([
        'stat() { if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%u" ]; then id -u; else command stat "$@"; fi; }',
        block,
        `prepare_openshell_sqlite_tmpdir ${JSON.stringify(sqliteTmp)}`,
        'printf "%s\\n" "$SQLITE_TMPDIR"',
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(sqliteTmp);
      expect(fs.statSync(sqliteTmp).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked SQLite temporary directory", () => {
    const block = sourceBlock(
      source,
      "prepare_openshell_sqlite_tmpdir() {",
      "# ── Main ─────────────────────────────────────────────────────────",
    );
    const tmp = fs.mkdtempSync(path.join(process.cwd(), ".tmp-openclaw-sqlite-"));
    const outside = path.join(tmp, "outside");
    const sqliteTmp = path.join(tmp, "sqlite-tmp");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, sqliteTmp);
    try {
      const result = runBash([
        block,
        `prepare_openshell_sqlite_tmpdir ${JSON.stringify(sqliteTmp)}`,
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing unsafe OpenClaw SQLite temporary directory");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    { expected: "1", initial: "caller-disabled", uid: 0 },
    { expected: "unset", initial: "1", uid: 1000 },
  ])("derives marker $expected for uid $uid", ({ expected, initial, uid }) => {
    const block = sourceBlock(
      source,
      "# OpenClaw 2026.9.1 enforces owner-only SQLite",
      "# Begin the root PID 1 readiness lease",
    );
    const result = runBash([
      `id() { if [ "\${1:-}" = "-u" ]; then printf ${JSON.stringify(String(uid))}; else command id "$@"; fi; }`,
      "prepare_openshell_sqlite_tmpdir() { :; }",
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
