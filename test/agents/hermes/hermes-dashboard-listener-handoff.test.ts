// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { extractShellFunction, runHermesBashHarness } from "../../support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");
const source = fs.readFileSync(START_SCRIPT, "utf-8");

function runListenerOwnerSelection(matchingPids: number[], previousPid = 101) {
  return runHermesBashHarness(
    [
      extractShellFunction(source, "hermes_find_reparented_role_listener_pid"),
      [
        "hermes_process_role_identity() {",
        '  [ "$1:$3:$4" = "dashboard:sandbox:19119" ] || return 1',
        '  case "$2" in',
        ...matchingPids.map((pid) => `    ${pid}) ;;`),
        "    *) return 1 ;;",
        "  esac",
        '  printf "identity-%s" "$2"',
        "}",
      ].join("\n"),
      [
        "hermes_tracked_service_owns_listener() {",
        '  hermes_process_role_identity dashboard "$1" sandbox 19119 >/dev/null',
        "}",
      ].join("\n"),
      '_HERMES_PROC_ROOT="$FIXTURE_PROC_ROOT"',
      `if selected="$(hermes_find_reparented_role_listener_pid dashboard sandbox 19119 ${previousPid})"; then`,
      '  printf "selected=%s\\n" "$selected"',
      "else",
      '  printf "selection-failed\\n"',
      "fi",
    ],
    (tmpDir) => {
      const procRoot = path.join(tmpDir, "proc");
      for (const pid of [previousPid, 202, 303]) {
        fs.mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
      }
      return { FIXTURE_PROC_ROOT: procRoot };
    },
  );
}

function runDashboardHandoff(delayed = false) {
  return runHermesBashHarness(
    [
      extractShellFunction(source, "start_socat_forwarder"),
      "hermes_tracked_role_is_current() { return 1; }",
      delayed
        ? 'hermes_find_reparented_role_listener_pid() { if [ ! -e "$HANDOFF_ATTEMPT" ]; then : >"$HANDOFF_ATTEMPT"; return 1; fi; printf 202; }'
        : "hermes_find_reparented_role_listener_pid() { printf 202; }",
      [
        "hermes_process_role_identity() {",
        '  [ "$1:$2:$3:$4" = "dashboard:202:current:19119" ] || return 1',
        "  printf identity-202",
        "}",
      ].join("\n"),
      [
        "hermes_set_role_identity() {",
        '  [ "$1" = dashboard ] || return 1',
        '  DASHBOARD_PID_START_IDENTITY="$2"',
        "}",
      ].join("\n"),
      [
        "hermes_tracked_service_owns_listener() {",
        '  [ "$1:$2:$3" = "202:19119:current" ]',
        "}",
      ].join("\n"),
      'gateway_control_pid_is_live() { kill -0 "$1" 2>/dev/null; }',
      "hermes_capture_tracked_role() { return 0; }",
      "gateway_control_pid_owns_tcp_listener() { return 0; }",
      "hermes_stop_tracked_role() { return 0; }",
      "hermes_fatal_unproven_child() { return 1; }",
      "sleep() { :; }",
      "INTERNAL_PORT=18642",
      "DASHBOARD_INTERNAL_PORT=19119",
      "DASHBOARD_PID=101",
      'start_socat_forwarder 18789 19119 dashboard DASHBOARD_SOCAT_PID "$DASHBOARD_PID" current',
      "handoff_status=$?",
      'printf "dashboard-pid=%s\\n" "$DASHBOARD_PID"',
      'printf "dashboard-identity=%s\\n" "$DASHBOARD_PID_START_IDENTITY"',
      'kill "$DASHBOARD_SOCAT_PID" 2>/dev/null || true',
      'wait "$DASHBOARD_SOCAT_PID" 2>/dev/null || true',
      'exit "$handoff_status"',
    ],
    (tmpDir) => {
      const binDir = path.join(tmpDir, "bin");
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, "socat"), "#!/usr/bin/env bash\nexec sleep 30\n", {
        mode: 0o700,
      });
      return {
        HANDOFF_ATTEMPT: path.join(tmpDir, "handoff-attempt"),
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      };
    },
  );
}

describe("Hermes dashboard listener handoff", () => {
  it("adopts the only verified replacement and excludes the exited launcher (#11905)", () => {
    const run = runListenerOwnerSelection([101, 202]);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("selected=202");
  });

  it("refuses an ambiguous replacement instead of adopting a sibling process (#11905)", () => {
    const run = runListenerOwnerSelection([202, 303]);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("selection-failed");
    expect(run.stdout).not.toContain("selected=");
  });

  it("updates the tracked dashboard identity before publishing its forwarder (#11905)", () => {
    const run = runDashboardHandoff();

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("dashboard-pid=202");
    expect(run.stdout).toContain("dashboard-identity=identity-202");
    expect(run.stderr).toContain("dashboard service handed off to verified listener owner pid 202");
  });

  it("waits for the verified listener child after its launcher exits (#11905)", () => {
    const run = runDashboardHandoff(true);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("dashboard-pid=202");
    expect(run.stderr).toContain("dashboard service handed off to verified listener owner pid 202");
  });
});
