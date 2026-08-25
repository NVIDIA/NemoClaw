// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { safeTmpHelpers } from "./nemoclaw-start-gateway.test-helpers";
import { extractShellFunctionFromSource } from "../../../support/shell-function-extractor";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");

describe("OpenClaw gateway credential environment", () => {
  it.each([
    "truncate",
    "append",
  ])("removes OPENCLAW_GATEWAY_TOKEN from the gateway environment without passing its value in argv when the log mode is %s (#8693)", (logMode) => {
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
      safeTmpHelpers(source),
      launch,
      "export OPENCLAW_GATEWAY_TOKEN=gateway-secret",
      `launch_openclaw_gateway_process ${logMode} current sh -c 'printf "ENV=%s\\nARGS=%s\\n" "\${OPENCLAW_GATEWAY_TOKEN-unset}" "$*"' sh`,
      'wait "$GATEWAY_PID"',
    ].join("\n");

    try {
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(0);
      const expectedOutput = "ENV=unset\nARGS=\n";
      expect(fs.readFileSync(gatewayLog, "utf8")).toBe(
        logMode === "append" ? `${seed}${expectedOutput}` : expectedOutput,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe.skipIf(!fs.existsSync("/proc/self/cmdline"))("Linux process inspection", () => {
    it.each([
      { logMode: "truncate", launchPath: "initial launch" },
      { logMode: "append", launchPath: "automatic respawn" },
    ])("keeps the gateway token out of process cmdline and environ during $launchPath (#8693)", ({
      logMode,
    }) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-token-proc-"));
      const gatewayLog = path.join(tmpDir, "gateway.log");
      const source = fs.readFileSync(START_SCRIPT, "utf8");
      const launch = extractShellFunctionFromSource(
        source,
        "launch_openclaw_gateway_process",
      ).replaceAll("/tmp/gateway.log", gatewayLog);
      fs.writeFileSync(gatewayLog, "");
      const script = [
        "set -euo pipefail",
        safeTmpHelpers(source),
        launch,
        "export OPENCLAW_GATEWAY_TOKEN=gateway-secret",
        `launch_openclaw_gateway_process ${logMode} current node -e 'setTimeout(() => {}, 30000)' nemoclaw-proc-credential-probe`,
        'trap \'kill "$GATEWAY_PID" 2>/dev/null || true; wait "$GATEWAY_PID" 2>/dev/null || true\' EXIT',
        "ready=0",
        "for _ in $(seq 1 100); do",
        '  [ -r "/proc/$GATEWAY_PID/cmdline" ] || { sleep 0.01; continue; }',
        "  process_cmdline=\"$(tr '\\0' '\\n' < \"/proc/$GATEWAY_PID/cmdline\")\"",
        '  case "$process_cmdline" in *nemoclaw-proc-credential-probe*) ready=1; break ;; esac',
        "  sleep 0.01",
        "done",
        '[ "$ready" -eq 1 ] || { echo "gateway process did not become inspectable" >&2; exit 30; }',
        "process_environment=\"$(tr '\\0' '\\n' < \"/proc/$GATEWAY_PID/environ\")\"",
        'case "$process_cmdline" in *"$OPENCLAW_GATEWAY_TOKEN"*) exit 31 ;; esac',
        'case "$process_environment" in *"OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN"*) exit 32 ;; esac',
        'kill "$GATEWAY_PID"',
        'wait "$GATEWAY_PID" 2>/dev/null || true',
        "trap - EXIT",
      ].join("\n");

      try {
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.status, result.stderr).toBe(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
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
      ["-c", [launch, "launch_openclaw_gateway_process invalid current true"].join("\n")],
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
