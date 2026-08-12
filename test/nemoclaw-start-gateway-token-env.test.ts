// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { extractShellFunctionFromSource } from "./support/shell-function-extractor";

const START_SCRIPT = path.resolve(import.meta.dirname, "../scripts/nemoclaw-start.sh");

describe("OpenClaw gateway credential environment", () => {
  it.each([
    "truncate",
    "append",
  ])("passes --token and removes OPENCLAW_GATEWAY_TOKEN when the log mode is %s (#8693)", (logMode) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-token-env-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const seed = "existing gateway output\n";
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const launch = extractShellFunctionFromSource(
      source,
      "launch_openclaw_gateway_process",
    ).replaceAll("/tmp/gateway.log", gatewayLog);
    fs.writeFileSync(gatewayLog, seed);
    const script = [
      "set -euo pipefail",
      launch,
      "export OPENCLAW_GATEWAY_TOKEN=gateway-secret",
      `launch_openclaw_gateway_process ${logMode} sh -c 'printf "ENV=%s\\nARGS=%s\\n" "\${OPENCLAW_GATEWAY_TOKEN-unset}" "$*"' sh`,
      'wait "$GATEWAY_PID"',
    ].join("\n");

    try {
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(0);
      const expectedOutput = "ENV=unset\nARGS=--token gateway-secret\n";
      expect(fs.readFileSync(gatewayLog, "utf8")).toBe(
        logMode === "append" ? `${seed}${expectedOutput}` : expectedOutput,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown gateway log mode before launch (#8693)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-token-env-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const launch = extractShellFunctionFromSource(
      source,
      "launch_openclaw_gateway_process",
    ).replaceAll("/tmp/gateway.log", gatewayLog);
    const result = spawnSync(
      "bash",
      ["-c", [launch, "launch_openclaw_gateway_process invalid true"].join("\n")],
      { encoding: "utf8", timeout: 5000 },
    );

    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("invalid gateway log mode: invalid");
      expect(fs.existsSync(gatewayLog)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
