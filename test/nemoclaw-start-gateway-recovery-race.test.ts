// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function extractShellFunction(source: string, name: string): string {
  const header = `${name}() {`;
  const start = source.indexOf(header);
  expect(start, `Expected ${name} in scripts/nemoclaw-start.sh`).not.toBe(-1);
  const body = source.slice(start + header.length);
  const closing = body.match(/^}$/m);
  expect(closing, `Expected closing brace for ${name} in scripts/nemoclaw-start.sh`).not.toBeNull();
  return `${name}() {${body.slice(0, closing?.index ?? 0)}\n}`;
}

describe("OpenClaw gateway recovery during respawn races", () => {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");

  it.each([
    ["already reaped", "0", "", ""],
    ["dead but not yet reaped", "101", "old-start", "reap:101:old-start"],
  ])("recovers when the previous gateway was %s", (_label, oldPid, oldIdentity, reapEvent) => {
    const script = [
      "set -uo pipefail",
      `GATEWAY_PID=${JSON.stringify(oldPid)}`,
      `GATEWAY_PID_START_IDENTITY=${JSON.stringify(oldIdentity)}`,
      "GATEWAY_CONTROL_ACTION=recover",
      "gateway_control_take_request() { printf 'take-request\\n'; }",
      "openclaw_gateway_healthy() { return 1; }",
      "prepare_openclaw_gateway_restart() { printf 'prepare\\n'; }",
      'run_openclaw_config_guard() { printf "guard:%s\\n" "$1"; }',
      "restore_openclaw_restart_config() { printf 'restore\\n'; }",
      "openclaw_supervised_pid_is_live() { return 1; }",
      "stop_openclaw_supervised_gateway() { printf 'unexpected-stop\\n'; return 1; }",
      "openclaw_reap_exited_gateway() {",
      '  printf "reap:%s:%s\\n" "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY"',
      "  GATEWAY_PID=0",
      "  GATEWAY_PID_START_IDENTITY=",
      "}",
      "mark_openclaw_gateway_stopped() { printf 'mark-stopped\\n'; GATEWAY_PID=0; GATEWAY_PID_START_IDENTITY=; }",
      "cleanup_openclaw_gateway_locks() { printf 'cleanup-locks\\n'; }",
      "launch_openclaw_gateway() { printf 'launch\\n'; GATEWAY_PID=202; GATEWAY_PID_START_IDENTITY=new-start; }",
      'wait_for_openclaw_gateway_internal() { printf "wait:%s:%s\\n" "$1" "$2"; }',
      "stop_openclaw_gateway_fail_closed() { printf 'unexpected-fail-closed\\n'; return 1; }",
      "refresh_openclaw_supervised_child_pids() { printf 'refresh-children\\n'; }",
      "start_plugin_registry_refresh() { printf 'plugin-refresh\\n'; }",
      'gateway_control_complete() { printf "complete:%s:%s:%s\\n" "$1" "$2" "$3"; }',
      'gateway_control_fail() { printf "unexpected-fail:%s:%s\\n" "$1" "$2"; }',
      extractShellFunction(source, "retire_openclaw_supervised_gateway"),
      extractShellFunction(source, "handle_openclaw_gateway_control_request"),
      "rc=0; handle_openclaw_gateway_control_request || rc=$?",
      'printf "rc:%s\\n" "$rc"',
    ].join("\n");

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(
      [
        "take-request",
        "prepare",
        "guard:seal-restart",
        reapEvent,
        "mark-stopped",
        "cleanup-locks",
        "launch",
        "refresh-children",
        "wait:202:new-start",
        "restore",
        "plugin-refresh",
        "refresh-children",
        `complete:ok:${oldPid}:202`,
        "rc:0",
      ].filter(Boolean),
    );
    expect(result.stdout).not.toContain("unexpected-");
  });

  it.each([
    ["a dead tracked gateway cannot be safely reaped", "101", "old-start", "101"],
    ["the stopped tuple retains an inconsistent wait PID", "0", "", "101"],
  ])("refuses recovery when %s", (_label, oldPid, oldIdentity, waitPid) => {
    const script = [
      "set -uo pipefail",
      `GATEWAY_PID=${JSON.stringify(oldPid)}`,
      `GATEWAY_PID_START_IDENTITY=${JSON.stringify(oldIdentity)}`,
      `SANDBOX_WAIT_PID=${JSON.stringify(waitPid)}`,
      "GATEWAY_CONTROL_ACTION=recover",
      "gateway_control_take_request() { printf 'take-request\\n'; }",
      "openclaw_gateway_healthy() { return 1; }",
      "prepare_openclaw_gateway_restart() { printf 'prepare\\n'; }",
      'run_openclaw_config_guard() { printf "guard:%s\\n" "$1"; }',
      "restore_openclaw_restart_config() { printf 'restore\\n'; }",
      "openclaw_supervised_pid_is_live() { return 1; }",
      "stop_openclaw_supervised_gateway() { printf 'unexpected-stop\\n'; return 1; }",
      "openclaw_reap_exited_gateway() { printf 'reap-refused\\n'; return 2; }",
      "mark_openclaw_gateway_stopped() { printf 'unexpected-mark\\n'; }",
      "cleanup_openclaw_gateway_locks() { printf 'unexpected-cleanup\\n'; }",
      "launch_openclaw_gateway() { printf 'unexpected-launch\\n'; }",
      'gateway_control_fail() { printf "fail:%s:%s\\n" "$1" "$2"; }',
      extractShellFunction(source, "retire_openclaw_supervised_gateway"),
      extractShellFunction(source, "handle_openclaw_gateway_control_request"),
      "rc=0; handle_openclaw_gateway_control_request || rc=$?",
      'printf "rc:%s\\n" "$rc"',
    ].join("\n");

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `take-request\nprepare\nguard:seal-restart\nreap-refused\nrestore\nfail:internal:${oldPid}\nrc:1\n`,
    );
    expect(result.stdout).not.toContain("unexpected-");
  });

  it.each([
    {
      label: "reports the existing gateway healthy",
      guardStatus: 0,
      healthStatus: 0,
      expected: [
        "take-request",
        "guard:preflight-restart",
        "healthy:4242:777",
        "complete:already-running:4242:4242",
        "rc:0",
      ],
    },
    {
      label: "rejects an unsafe config before checking health",
      guardStatus: 1,
      healthStatus: 0,
      expected: ["take-request", "guard:preflight-restart", "fail:unsafe-config:4242", "rc:1"],
    },
    {
      label: "reports an unhealthy gateway after config validation",
      guardStatus: 0,
      healthStatus: 1,
      expected: [
        "take-request",
        "guard:preflight-restart",
        "healthy:4242:777",
        "fail:health-timeout:4242",
        "rc:1",
      ],
    },
  ])("keeps the authenticated probe read-only when it $label", ({
    guardStatus,
    healthStatus,
    expected,
  }) => {
    const script = [
      "set -uo pipefail",
      "GATEWAY_PID=4242",
      'GATEWAY_PID_START_IDENTITY="777"',
      "gateway_control_take_request() { GATEWAY_CONTROL_ACTION=probe; printf 'take-request\\n'; }",
      `run_openclaw_config_guard() { printf "guard:%s\\n" "$1"; return ${guardStatus}; }`,
      `openclaw_gateway_healthy() { printf "healthy:%s:%s\\n" "$1" "$2"; return ${healthStatus}; }`,
      'gateway_control_complete() { printf "complete:%s:%s:%s\\n" "$1" "$2" "$3"; }',
      'gateway_control_fail() { printf "fail:%s:%s\\n" "$1" "$2"; }',
      "prepare_openclaw_gateway_restart() { printf 'unexpected-prepare\\n'; }",
      "retire_openclaw_supervised_gateway() { printf 'unexpected-retire\\n'; }",
      "mark_openclaw_gateway_stopped() { printf 'unexpected-mark-stopped\\n'; }",
      "launch_openclaw_gateway() { printf 'unexpected-launch\\n'; }",
      "stop_openclaw_gateway_fail_closed() { printf 'unexpected-stop\\n'; }",
      "kill() { printf 'unexpected-signal\\n'; }",
      extractShellFunction(source, "handle_openclaw_gateway_control_request"),
      "rc=0; handle_openclaw_gateway_control_request || rc=$?",
      'printf "rc:%s\\n" "$rc"',
    ].join("\n");

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(expected);
    expect(result.stdout).not.toContain("unexpected-");
  });
});
