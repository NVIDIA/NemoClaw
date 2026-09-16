// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");
const SOURCE = fs.readFileSync(START_SCRIPT, "utf-8");

function shellFunction(name: string): string {
  return extractShellFunctionFromSource(SOURCE, name);
}

function runSupervisor(fixture: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        shellFunction("openclaw_restart_handoff_capabilities_valid"),
        shellFunction("classify_openclaw_restart_handoff"),
        shellFunction("supervise_openclaw_gateway"),
        fixture,
      ].join("\n"),
    ],
    { encoding: "utf-8", timeout: 10_000 },
  );
}

describe("nemoclaw-start external gateway supervision", () => {
  it("consumes an exact accepted handoff, relaunches, then permits a clean stop", () => {
    const result = runSupervisor(String.raw`
mark_openclaw_gateway_stopped() { :; }
run_openclaw_restart_handoff_cli() {
  case "$1" in
    capabilities)
      printf '%s\n' '{"ok":true,"protocol":"openclaw.gateway.restart-handoff","protocolVersion":1,"operations":["consume"]}'
      ;;
    consume)
      expected_pid="$3"
      if [ "$expected_pid" = "$initial_pid" ]; then
        printf '{"ok":true,"protocol":"openclaw.gateway.restart-handoff","protocolVersion":1,"status":"accepted","handoff":{"pid":%s,"supervisorMode":"external","restartKind":"full-process"}}\n' "$expected_pid"
      else
        printf '%s\n' '{"ok":true,"protocol":"openclaw.gateway.restart-handoff","protocolVersion":1,"status":"none","reason":"missing"}'
      fi
      ;;
  esac
}
launch_openclaw_gateway_replacement() {
  printf 'replacement:%s\n' "$1"
  (exit 0) &
  GATEWAY_PID=$!
}
(exit 0) &
GATEWAY_PID=$!
initial_pid="$GATEWAY_PID"
supervise_openclaw_gateway sandbox
`);

    expect({ status: result.status, stdout: result.stdout }).toEqual({
      status: 0,
      stdout: "replacement:sandbox\n",
    });
    expect(result.stderr).toContain("stopped cleanly without a restart handoff");
  });

  it("fails closed when a consume result is malformed after the gateway exits", () => {
    const result = runSupervisor(String.raw`
mark_openclaw_gateway_stopped() { :; }
run_openclaw_restart_handoff_cli() {
  case "$1" in
    capabilities)
      printf '%s\n' '{"ok":true,"protocol":"openclaw.gateway.restart-handoff","protocolVersion":1,"operations":["consume"]}'
      ;;
    consume) printf '%s\n' '{"ok":true,"status":"accepted"}' ;;
  esac
}
launch_openclaw_gateway_replacement() { printf '%s\n' unexpected-relaunch; }
(exit 0) &
GATEWAY_PID=$!
supervise_openclaw_gateway current
`);

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("unexpected-relaunch");
    expect(result.stderr).toContain(
      "restart-handoff was absent or refused; leaving the gateway safely stopped",
    );
  });

  it("requires append logging and startup proof for a replacement", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          shellFunction("launch_openclaw_gateway_replacement"),
          'mark_in_container_gateway() { printf "%s\\n" marker; }',
          'launch_openclaw_gateway_process() { printf "launch:%s:%s\\n" "$1" "$2"; (sleep 5) & GATEWAY_PID=$!; }',
          'capture_openclaw_pid_start_identity() { printf -v "$2" "%s" identity; }',
          'record_gateway_pid() { printf "record:%s:%s\\n" "$1" "$2"; }',
          "_nemoclaw_capture_epoch_realtime() { :; }",
          "record_portable_openclaw_gateway_startup_timing() { :; }",
          "refresh_openclaw_supervised_child_pids() { :; }",
          'wait_for_openclaw_gateway_internal() { printf "startup:%s:%s\\n" "$1" "$2"; }',
          "clear_gateway_pid_record() { :; }",
          "OPENCLAW=/usr/local/bin/openclaw",
          "_DASHBOARD_PORT=18789",
          "launch_openclaw_gateway_replacement sandbox",
          'kill "$GATEWAY_PID"',
          'wait "$GATEWAY_PID" 2>/dev/null || true',
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^marker\nlaunch:append:sandbox\nrecord:[0-9]+:identity\nstartup:[0-9]+:identity\n$/,
    );
  });

  it("stops a replacement that cannot prove startup readiness", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          shellFunction("launch_openclaw_gateway_replacement"),
          "mark_in_container_gateway() { :; }",
          "launch_openclaw_gateway_process() { (sleep 5) & GATEWAY_PID=$!; }",
          'capture_openclaw_pid_start_identity() { printf -v "$2" "%s" identity; }',
          "record_gateway_pid() { :; }",
          "refresh_openclaw_supervised_child_pids() { :; }",
          "wait_for_openclaw_gateway_internal() { return 1; }",
          'stop_openclaw_supervised_gateway() { printf "stop:%s:%s\\n" "$1" "$2"; kill "$1"; wait "$1" 2>/dev/null || true; }',
          'mark_openclaw_gateway_stopped() { printf "%s\\n" stopped; }',
          "OPENCLAW=/usr/local/bin/openclaw",
          "_DASHBOARD_PORT=18789",
          "launch_openclaw_gateway_replacement sandbox",
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^stop:[0-9]+:identity\nstopped\n$/);
    expect(result.stderr).toContain("replacement did not prove listener ownership");
  });

  it("reaps a replacement whose process identity cannot be captured", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          shellFunction("launch_openclaw_gateway_replacement"),
          "mark_in_container_gateway() { :; }",
          'launch_openclaw_gateway_process() { (sleep 5) & GATEWAY_PID=$!; launched_pid="$GATEWAY_PID"; printf "%s\\n" "$GATEWAY_PID"; }',
          "capture_openclaw_pid_start_identity() { return 1; }",
          'clear_gateway_pid_record() { printf "%s\\n" cleared; }',
          "OPENCLAW=/usr/local/bin/openclaw",
          "_DASHBOARD_PORT=18789",
          "set +e",
          "launch_openclaw_gateway_replacement sandbox",
          "replacement_rc=$?",
          "set -e",
          'if [ "$replacement_rc" -eq 0 ]; then exit 64; fi',
          'if kill -0 "$launched_pid" 2>/dev/null; then exit 65; fi',
          'printf "%s\\n" reaped',
          'exit "$replacement_rc"',
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status).toBe(1);
    const [replacementPid, marker, reaped] = result.stdout.trim().split("\n");
    expect(replacementPid).toMatch(/^\d+$/u);
    expect(marker).toBe("cleared");
    expect(reaped).toBe("reaped");
    expect(result.stderr).toContain("could not capture replacement gateway process identity");
  });
});
