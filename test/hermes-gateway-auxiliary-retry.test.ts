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
