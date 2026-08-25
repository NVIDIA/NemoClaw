// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { extractShellFunctionFromSource } from "../../../support/shell-function-extractor";

const START_SCRIPT = path.join(import.meta.dirname, "..", "../../..", "scripts", "nemoclaw-start.sh");

function safeTmpHelpers(src: string): string {
  const start = src.indexOf("_nemoclaw_safe_replace_tmp_file() {");
  const end = src.indexOf("_START_LOG=", start);
  if (start === -1 || end === -1 || end <= start) throw new Error("Expected safe temp helpers");
  return src.slice(start, end);
}

describe("nemoclaw-start safe tmp file creation", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it.each([
    ["root parent after CAP_DAC_OVERRIDE drop", "0", "3|/tmp/auto-pair.log 600 root:root"],
    ["non-root parent", "998", "2|/tmp/auto-pair.log 600"],
  ])("creates an auto-pair log for the %s", (_label, uid, expected) => {
    const prepareAutoPairLog = extractShellFunctionFromSource(src, "prepare_auto_pair_log");
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          `id() { test \"\${1:-}\" = -u && printf '%s' ${JSON.stringify(uid)}; }`,
          `_nemoclaw_safe_create_tmp_file() { printf '%s|%s\\n' \"$#\" \"$*\"; }`,
          prepareAutoPairLog,
          "prepare_auto_pair_log",
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it("creates fixed runtime paths through the safe helper with the requested modes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-safe-tmp-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const autoPairLog = path.join(tmpDir, "auto-pair.log");
    const pidFile = path.join(tmpDir, "nemoclaw-gateway.pid");

    try {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        safeTmpHelpers(src),
        `_nemoclaw_safe_create_tmp_file ${JSON.stringify(gatewayLog)} 644`,
        `_nemoclaw_safe_create_tmp_file ${JSON.stringify(autoPairLog)} 600`,
        `printf '%s\\n' 12345 | _nemoclaw_safe_replace_tmp_file ${JSON.stringify(pidFile)} 600 "" best-effort`,
      ].join("\n");

      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

      expect(result.status).toBe(0);
      expect((fs.statSync(gatewayLog).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(autoPairLog).mode & 0o777).toString(8)).toBe("600");
      expect((fs.statSync(pidFile).mode & 0o777).toString(8)).toBe("600");
      expect(fs.readFileSync(pidFile, "utf-8")).toBe("12345\n");
      expect(fs.readdirSync(tmpDir).filter((entry) => entry.includes(".tmp."))).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("replaces a planted gateway-log symlink before the initial launch", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-safe-tmp-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const symlinkTarget = path.join(tmpDir, "symlink-target.log");
    const launch = extractShellFunctionFromSource(
      src,
      "launch_openclaw_gateway_process",
    ).replaceAll("/tmp/gateway.log", gatewayLog);

    try {
      fs.writeFileSync(symlinkTarget, "do not overwrite\n");
      fs.symlinkSync(symlinkTarget, gatewayLog);
      const script = [
        "set -euo pipefail",
        safeTmpHelpers(src),
        launch,
        "export OPENCLAW_GATEWAY_TOKEN=gateway-secret",
        `launch_openclaw_gateway_process truncate current printf '%s\\n' 'gateway started'`,
        'wait "$GATEWAY_PID"',
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf-8",
        timeout: 5000,
      });

      expect(result.status, result.stderr).toBe(0);
      const descriptor = fs.openSync(gatewayLog, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        expect(fs.readFileSync(descriptor, "utf-8")).toBe("gateway started\n");
      } finally {
        fs.closeSync(descriptor);
      }
      expect(fs.readFileSync(symlinkTarget, "utf-8")).toBe("do not overwrite\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not launch a gateway when initial log replacement fails", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-safe-tmp-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const launchSentinel = path.join(tmpDir, "gateway-launched");
    const processLaunch = extractShellFunctionFromSource(
      src,
      "launch_openclaw_gateway_process",
    ).replaceAll("/tmp/gateway.log", gatewayLog);
    const gatewayLaunch = extractShellFunctionFromSource(src, "launch_openclaw_gateway");

    try {
      fs.writeFileSync(gatewayLog, "stale gateway output\n");
      const script = [
        "set -uo pipefail",
        "_nemoclaw_safe_create_tmp_file() { return 1; }",
        processLaunch,
        `if launch_openclaw_gateway_process truncate current sh -c 'printf launched > ${JSON.stringify(launchSentinel)}'; then wait "$GATEWAY_PID"; exit 30; fi`,
        '[ -z "${GATEWAY_PID:-}" ] || exit 31',
        `[ ! -e ${JSON.stringify(launchSentinel)} ] || exit 32`,
        "launch_openclaw_gateway_process() { return 1; }",
        "arm_openclaw_gateway_supervisor_cleanup() { :; }",
        "mark_in_container_gateway() { :; }",
        'capture_openclaw_pid_start_identity() { printf launched > "$CAPTURE_SENTINEL"; return 0; }',
        `CAPTURE_SENTINEL=${JSON.stringify(launchSentinel)}`,
        "record_gateway_pid() { :; }",
        "STEP_DOWN_PREFIX_GATEWAY=(env)",
        "OPENCLAW=true",
        "_DASHBOARD_PORT=18789",
        gatewayLaunch,
        "if launch_openclaw_gateway; then exit 33; fi",
        '[ -z "${GATEWAY_PID:-}" ] || exit 31',
        `[ ! -e ${JSON.stringify(launchSentinel)} ] || exit 32`,
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf-8",
        timeout: 5000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(gatewayLog, "utf-8")).toBe("stale gateway output\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses a planted gateway-log symlink during automatic respawn", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-safe-tmp-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const symlinkTarget = path.join(tmpDir, "symlink-target.log");
    const launch = extractShellFunctionFromSource(
      src,
      "launch_openclaw_gateway_process",
    ).replaceAll("/tmp/gateway.log", gatewayLog);

    try {
      fs.writeFileSync(symlinkTarget, "do not append\n");
      fs.symlinkSync(symlinkTarget, gatewayLog);
      const script = [
        "set -uo pipefail",
        launch,
        "export OPENCLAW_GATEWAY_TOKEN=gateway-secret",
        "launch_openclaw_gateway_process append current true",
        'wait "$GATEWAY_PID"',
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf-8",
        timeout: 5000,
      });

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("refusing unsafe gateway log path");
      expect(fs.readFileSync(symlinkTarget, "utf-8")).toBe("do not append\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
