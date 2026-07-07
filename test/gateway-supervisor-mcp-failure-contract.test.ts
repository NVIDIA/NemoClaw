// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTROL_HELPER = path.join(REPO_ROOT, "scripts", "gateway-control.sh");
const NONCE = "a".repeat(64);

function withTmpDir(run: (tmpDir: string) => void): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-supervisor-contract-"));
  try {
    run(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("gateway supervisor MCP failure contract (#6257)", () => {
  it.each([
    "mcp-integrity",
    "mcp-reconcile-required",
  ])("preserves the %s failure code in supervisor status", (failureCode) => {
    withTmpDir((tmpDir) => {
      const controlDir = path.join(tmpDir, "control");
      fs.mkdirSync(controlDir, { mode: 0o700 });
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -eu",
            'export NEMOCLAW_GATEWAY_CONTROL_DIR="$1"',
            ". scripts/lib/gateway-supervisor.sh",
            'GATEWAY_CONTROL_NONCE="$2"',
            'gateway_control_fail "$3" 4242',
            'cat "$NEMOCLAW_GATEWAY_CONTROL_STATUS"',
          ].join("\n"),
          "gateway-supervisor-mcp-failure-contract",
          controlDir,
          NONCE,
          failureCode,
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(`v1 ${NONCE} failed ${failureCode} 4242 0`);
    });
  });

  it.each([
    "mcp-integrity",
    "mcp-reconcile-required",
  ])("maps %s to the stable host-visible MCP drift marker", (failureCode) => {
    withTmpDir((tmpDir) => {
      const controlDir = path.join(tmpDir, "control");
      const procRoot = path.join(tmpDir, "proc");
      fs.mkdirSync(controlDir, { mode: 0o700 });
      fs.mkdirSync(path.join(procRoot, "1"), { recursive: true });
      fs.writeFileSync(path.join(procRoot, "1", "cmdline"), "bash\0nemoclaw-start\0");
      const wrapper = path.join(tmpDir, "run-control.sh");
      fs.writeFileSync(
        wrapper,
        [
          "#!/usr/bin/env bash",
          "set -eu",
          'stat() { printf "%s\\n" "root:root 700"; }',
          'FAILURE_CODE="${NEMOCLAW_TEST_FAILURE_CODE:?}"',
          'TEST_NONCE="${NEMOCLAW_TEST_NONCE:?}"',
          'kill() { printf "v1 %s failed %s 4242 0\\n" "$TEST_NONCE" "$FAILURE_CODE" >"$NEMOCLAW_GATEWAY_CONTROL_DIR/status"; }',
          'set -- restart "$TEST_NONCE"',
          '. "${NEMOCLAW_TEST_CONTROL_HELPER:?}"',
        ].join("\n"),
        { mode: 0o700 },
      );

      const result = spawnSync("bash", [wrapper], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_GATEWAY_CONTROL_DIR: controlDir,
          NEMOCLAW_TEST_CONTROL_HELPER: CONTROL_HELPER,
          NEMOCLAW_TEST_FAILURE_CODE: failureCode,
          NEMOCLAW_TEST_GATEWAY_CONTROL_CALLER_UID: "0",
          NEMOCLAW_TEST_GATEWAY_CONTROL_PROC_ROOT: procRoot,
          NEMOCLAW_TEST_NONCE: NONCE,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`failed ${failureCode} 4242 0`);
      expect(result.stderr).toContain("HERMES_MCP_CONFIG_DRIFT");
      expect(result.stderr).not.toContain("GATEWAY_FAILED");
    });
  });
});
