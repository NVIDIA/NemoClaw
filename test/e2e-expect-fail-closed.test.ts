// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readScript(pathname: string): string {
  return readFileSync(new URL(pathname, import.meta.url), "utf8");
}

function commandOverride(): string {
  return [
    "command() {",
    '  if [ "${1:-}" = "-v" ] && [ "${2:-}" = "expect" ]; then',
    "    return 1",
    "  fi",
    '  builtin command "$@"',
    "}",
  ].join("\n");
}

function runBash(script: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000 });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function extractExpectIfBlock(source: string, message: string): string {
  const messageIndex = source.indexOf(message);
  expect(messageIndex, message).toBeGreaterThan(-1);
  const start = source.lastIndexOf("if ! command -v expect", messageIndex);
  const end = source.indexOf("\n  fi", messageIndex);
  expect(start, message).toBeGreaterThan(-1);
  expect(end, message).toBeGreaterThan(-1);
  return source.slice(start, end + "\n  fi".length);
}

function extractExpectThenBranch(source: string, message: string): string {
  const messageIndex = source.indexOf(message);
  expect(messageIndex, message).toBeGreaterThan(-1);
  const start = source.lastIndexOf("if ! command -v expect", messageIndex);
  const end = source.indexOf("\nelse", messageIndex);
  expect(start, message).toBeGreaterThan(-1);
  expect(end, message).toBeGreaterThan(-1);
  return `${source.slice(start, end)}\nfi`;
}

describe("interactive E2E expect prerequisites", () => {
  it("fails network-policy preflight when expect is unavailable", () => {
    const source = readScript("./e2e/test-network-policy.sh");
    const expectBlock = extractExpectIfBlock(
      source,
      "ERROR: expect is required for interactive network policy coverage",
    );
    const result = runBash(
      ["set -euo pipefail", 'log() { printf "%s\\n" "$*"; }', commandOverride(), expectBlock].join(
        "\n",
      ),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "ERROR: expect is required for interactive network policy coverage",
    );
  });

  it("does not keep a non-interactive fallback in the network-policy interactive case", () => {
    const source = readScript("./e2e/test-network-policy.sh");
    const start = source.indexOf("test_net_03_live_policy_add()");
    const end = source.indexOf("test_net_04_dry_run()");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const testCase = source.slice(start, end);

    expect(testCase).toContain('fail "TC-NET-03: Interactive policy-add"');
    expect(testCase).not.toContain('apply_preset "slack"');
  });

  it("records a GPU TUI guard failure when expect is unavailable", () => {
    const source = readScript("./e2e/test-gpu-e2e.sh");
    const expectBranch = extractExpectThenBranch(
      source,
      "expect is required for the OpenClaw TUI first-turn compaction guard",
    );
    const result = runBash(
      [
        "set -euo pipefail",
        'fail() { printf "FAIL %s\\n" "$*"; }',
        'skip() { printf "SKIP %s\\n" "$*"; }',
        'pass() { printf "PASS %s\\n" "$*"; }',
        commandOverride(),
        expectBranch,
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "FAIL [#5468] expect is required for the OpenClaw TUI first-turn compaction guard",
    );
    expect(result.stdout).not.toContain("SKIP ");
    expect(result.stdout).not.toContain("PASS ");
  });
});
