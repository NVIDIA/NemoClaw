// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractShellFunction,
  runHermesBashHarness as runBashHarness,
} from "./support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

function writeFakeProcCmdline(procRoot: string, pid: number, args: string[]): void {
  const processDir = path.join(procRoot, String(pid));
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "cmdline"), Buffer.from(`${args.join("\0")}\0`));
}

describe("Hermes gateway auxiliary retry", () => {
  it("retries transient auxiliary failures without churning the healthy gateway", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "prepare_hermes_nonroot_runtime() { return 0; }",
      'launch_hermes_gateway_current_user() { launch_calls=$((launch_calls + 1)); GATEWAY_PID=6001; trace "launch:$GATEWAY_PID"; }',
      'wait_for_hermes_gateway_internal() { trace "internal:$1"; return 0; }',
      'hermes_tracked_role_is_current() { trace "identity:$2"; return 0; }',
      'hermes_gateway_healthy() { trace "health:$1"; return 0; }',
      'ensure_hermes_supervised_auxiliaries() { auxiliary_calls=$((auxiliary_calls + 1)); trace "auxiliary:$auxiliary_calls"; [ "$auxiliary_calls" -ge 3 ]; }',
      "commit_hermes_mcp_applied_if_pending() { trace commit-applied; return 0; }",
      "refresh_hermes_supervised_child_pids() { trace refresh; }",
      'hermes_stop_tracked_role() { trace "unexpected-stop:$2"; return 1; }',
      "mark_hermes_gateway_stopped() { trace unexpected-mark; }",
      "record_hermes_managed_gateway_exit() { trace unexpected-exit-record; }",
      'sleep() { trace "sleep:$1"; }',
      extractShellFunction(source, "recover_hermes_gateway_current_user"),
      "INTERNAL_PORT=18642",
      "launch_calls=0",
      "auxiliary_calls=0",
      "recover_hermes_gateway_current_user",
      'trace "launch-count:$launch_calls"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "launch:6001",
      "internal:6001",
      "identity:6001",
      "health:6001",
      "auxiliary:1",
      "sleep:1",
      "identity:6001",
      "health:6001",
      "auxiliary:2",
      "sleep:1",
      "identity:6001",
      "health:6001",
      "auxiliary:3",
      "identity:6001",
      "health:6001",
      "commit-applied",
      "refresh",
      "launch-count:1",
    ]);
    expect(result.stderr.match(/auxiliary repair failed/g)).toHaveLength(2);
    expect(result.stdout).not.toContain("unexpected-");
  });

  it("stops and charges a replacement that loses health during auxiliary retry", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "prepare_hermes_nonroot_runtime() { return 0; }",
      'launch_hermes_gateway_current_user() { GATEWAY_PID=6001; trace "launch:$GATEWAY_PID"; }',
      'wait_for_hermes_gateway_internal() { trace "internal:$1"; return 0; }',
      'hermes_tracked_role_is_current() { trace "identity:$2"; return 0; }',
      'hermes_gateway_healthy() { health_calls=$((health_calls + 1)); trace "health:$health_calls"; [ "$health_calls" -eq 1 ]; }',
      "ensure_hermes_supervised_auxiliaries() { trace auxiliary-failed; return 1; }",
      'hermes_stop_tracked_role() { trace "stop:$2"; return 0; }',
      "mark_hermes_gateway_stopped() { trace mark-stopped; GATEWAY_PID=0; }",
      "record_hermes_managed_gateway_exit() { trace exit-record; return 1; }",
      'sleep() { trace "sleep:$1"; }',
      extractShellFunction(source, "recover_hermes_gateway_current_user"),
      "INTERNAL_PORT=18642",
      "health_calls=0",
      'if recover_hermes_gateway_current_user; then trace unexpected-success; else trace "failure:$?"; fi',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "launch:6001",
      "internal:6001",
      "identity:6001",
      "health:1",
      "auxiliary-failed",
      "sleep:1",
      "identity:6001",
      "health:2",
      "stop:6001",
      "mark-stopped",
      "exit-record",
      "failure:1",
    ]);
    expect(result.stdout).not.toContain("unexpected-success");
  });
});

describe("Hermes gateway relay convergence", () => {
  it("preserves exact tracked relays while removing matching orphan processes", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness(
      [
        'trace() { printf "%s\\n" "$*"; }',
        'kill() { trace "kill:$1"; }',
        'hermes_tracked_role_is_current() { case "$1:$2" in api-socat:101|dashboard-socat:303) trace "preserve:$1:$2"; return 0 ;; *) return 1 ;; esac; }',
        extractShellFunction(source, "cleanup_orphan_socat_forwarders"),
        'NEMOCLAW_PROC_ROOT="$TEST_PROC_ROOT"',
        "PUBLIC_PORT=8642",
        "INTERNAL_PORT=18642",
        "DASHBOARD_PUBLIC_PORT=18789",
        "DASHBOARD_INTERNAL_PORT=19119",
        "SOCAT_PID=101",
        "DASHBOARD_SOCAT_PID=303",
        "cleanup_orphan_socat_forwarders",
      ],
      (tmpDir) => {
        const procRoot = path.join(tmpDir, "proc");
        const apiArgs = [
          "socat",
          "TCP-LISTEN:8642,bind=0.0.0.0,fork,reuseaddr",
          "TCP:127.0.0.1:18642",
        ];
        const dashboardArgs = [
          "socat",
          "TCP-LISTEN:18789,bind=0.0.0.0,fork,reuseaddr",
          "TCP:127.0.0.1:19119",
        ];
        writeFakeProcCmdline(procRoot, 101, apiArgs);
        writeFakeProcCmdline(procRoot, 202, apiArgs);
        writeFakeProcCmdline(procRoot, 303, dashboardArgs);
        writeFakeProcCmdline(procRoot, 404, dashboardArgs);
        return { TEST_PROC_ROOT: procRoot };
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("preserve:api-socat:101");
    expect(result.stdout).toContain("preserve:dashboard-socat:303");
    expect(result.stdout).toContain("kill:202");
    expect(result.stdout).toContain("kill:404");
    expect(result.stdout).not.toContain("kill:101");
    expect(result.stdout).not.toContain("kill:303");
  });

  it("removes a recorded relay when its exact tracked identity is not proven", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness(
      [
        'trace() { printf "%s\\n" "$*"; }',
        'kill() { trace "kill:$1"; }',
        "hermes_tracked_role_is_current() { return 1; }",
        extractShellFunction(source, "cleanup_orphan_socat_forwarders"),
        'NEMOCLAW_PROC_ROOT="$TEST_PROC_ROOT"',
        "PUBLIC_PORT=8642",
        "INTERNAL_PORT=18642",
        "DASHBOARD_PUBLIC_PORT=18789",
        "DASHBOARD_INTERNAL_PORT=19119",
        "SOCAT_PID=101",
        'DASHBOARD_SOCAT_PID=""',
        "cleanup_orphan_socat_forwarders",
      ],
      (tmpDir) => {
        const procRoot = path.join(tmpDir, "proc");
        writeFakeProcCmdline(procRoot, 101, [
          "socat",
          "TCP-LISTEN:8642,bind=0.0.0.0,fork,reuseaddr",
          "TCP:127.0.0.1:18642",
        ]);
        return { TEST_PROC_ROOT: procRoot };
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("kill:101\n");
  });

  it("retries transient public health without churning an exact listener", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness(
      [
        'trace() { printf "%s\\n" "$*"; }',
        "exec 3>&1",
        'id() { [ "${1:-}" = "-u" ] && printf "1000\\n"; }',
        "hermes_socat_bridge_healthy() { return 0; }",
        'curl() { count="$(cat "$TEST_PROBE_FILE")"; count=$((count + 1)); printf "%s\\n" "$count" >"$TEST_PROBE_FILE"; printf "public-probe:%s\\n" "$count" >&3; if [ "$count" -lt 3 ]; then printf "503"; else printf "200"; fi; }',
        'hermes_stop_tracked_role() { trace "unexpected-stop:$2"; return 1; }',
        'start_socat_forwarder() { trace "unexpected-start:$*"; return 1; }',
        "hermes_dashboard_healthy() { return 0; }",
        "ensure_gateway_log_stream() { trace gateway-log; }",
        extractShellFunction(source, "hermes_api_socat_bridge_healthy"),
        extractShellFunction(source, "ensure_hermes_supervised_auxiliaries"),
        "PUBLIC_PORT=8642",
        "INTERNAL_PORT=18642",
        "DASHBOARD_PUBLIC_PORT=18789",
        "DASHBOARD_INTERNAL_PORT=19119",
        "SOCAT_PID=101",
        "DASHBOARD_PID=202",
        "DASHBOARD_SOCAT_PID=303",
        "GATEWAY_PID=4242",
        'for attempt in 1 2 3; do if ensure_hermes_supervised_auxiliaries; then trace "result:$attempt:ready"; else trace "result:$attempt:waiting"; fi; done',
      ],
      (tmpDir) => {
        const probeFile = path.join(tmpDir, "probe-count");
        fs.writeFileSync(probeFile, "0\n");
        return { TEST_PROBE_FILE: probeFile };
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("result:1:waiting");
    expect(result.stdout).toContain("result:2:waiting");
    expect(result.stdout).toContain("result:3:ready");
    expect(result.stdout).not.toContain("unexpected-");
    expect(result.stdout.match(/public-probe:/g)).toHaveLength(3);
  });

  it("replaces structural listener loss once and preserves a public-red replacement", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'id() { [ "${1:-}" = "-u" ] && printf "1000\\n"; }',
      'hermes_socat_bridge_healthy() { [ "$1:$2" != "api-socat:101" ]; }',
      'curl() { printf "503"; }',
      'hermes_stop_tracked_role() { trace "stop:$2"; return 0; }',
      'start_socat_forwarder() { trace "start:$*"; printf -v "$4" 111; return 0; }',
      "hermes_dashboard_healthy() { trace unexpected-dashboard; return 0; }",
      "ensure_gateway_log_stream() { trace unexpected-log; }",
      extractShellFunction(source, "hermes_api_socat_bridge_healthy"),
      extractShellFunction(source, "ensure_hermes_supervised_auxiliaries"),
      "PUBLIC_PORT=8642",
      "INTERNAL_PORT=18642",
      "DASHBOARD_PUBLIC_PORT=18789",
      "DASHBOARD_INTERNAL_PORT=19119",
      "SOCAT_PID=101",
      "DASHBOARD_PID=202",
      "DASHBOARD_SOCAT_PID=303",
      "GATEWAY_PID=4242",
      'for attempt in 1 2; do if ensure_hermes_supervised_auxiliaries; then trace "unexpected-ready:$attempt"; else trace "waiting:$attempt"; fi; done',
      'trace "final-api-bridge:$SOCAT_PID"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^stop:/gm)).toHaveLength(1);
    expect(result.stdout.match(/^start:/gm)).toHaveLength(1);
    expect(result.stdout).toContain("waiting:1");
    expect(result.stdout).toContain("waiting:2");
    expect(result.stdout).toContain("final-api-bridge:111");
    expect(result.stdout).not.toContain("unexpected-");
  });
});
