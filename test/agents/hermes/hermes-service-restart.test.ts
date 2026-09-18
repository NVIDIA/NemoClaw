// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { extractShellFunction } from "../../support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");
const source = fs.readFileSync(START_SCRIPT, "utf8");

function runSupervisor(firstExit: number, finalExit: number) {
  const script = [
    "set -uo pipefail",
    "readonly HERMES_SERVICE_RESTART_STATUS=75",
    "GATEWAY_PID=100",
    "wait_count=0",
    "launch_count=0",
    "mark_count=0",
    "ready_count=0",
    "auxiliary_count=0",
    "finalize_count=0",
    "refresh_count=0",
    "recovery_count=0",
    `first_exit=${firstExit}`,
    `final_exit=${finalExit}`,
    'wait() { wait_count=$((wait_count + 1)); if [ "$wait_count" -eq 1 ]; then return "$first_exit"; fi; return "$final_exit"; }',
    "mark_hermes_gateway_stopped() { mark_count=$((mark_count + 1)); }",
    "launch_hermes_gateway_current_user() { launch_count=$((launch_count + 1)); GATEWAY_PID=$((GATEWAY_PID + 1)); }",
    "wait_for_hermes_gateway_internal() { ready_count=$((ready_count + 1)); }",
    "ensure_hermes_supervised_auxiliaries() { auxiliary_count=$((auxiliary_count + 1)); }",
    "finalize_tirith_marker_retry() { finalize_count=$((finalize_count + 1)); }",
    "refresh_hermes_supervised_child_pids() { refresh_count=$((refresh_count + 1)); }",
    "wait_for_hermes_gateway_recovery_request() { recovery_count=$((recovery_count + 1)); }",
    extractShellFunction(source, "relaunch_hermes_gateway_current_user"),
    extractShellFunction(source, "supervise_hermes_service_restarts_current_user"),
    "status=0",
    "supervise_hermes_service_restarts_current_user || status=$?",
    'printf "%s\\n" "status=$status waits=$wait_count launches=$launch_count marks=$mark_count ready=$ready_count auxiliaries=$auxiliary_count finalize=$finalize_count refresh=$refresh_count recoveries=$recovery_count gateway=$GATEWAY_PID"',
  ].join("\n");
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    timeout: 5_000,
  });
}

describe("Hermes native service restart supervision", () => {
  it("accepts a matching gated request published after the wait generation", () => {
    const script = [
      "set -uo pipefail",
      'request_identity="v1 $(printf d%.0s {1..64})"',
      'publish_hermes_gateway_recovery_generation() { HERMES_GATEWAY_RECOVERY_GENERATION="$(printf a%.0s {1..64})"; }',
      'hermes_gateway_recovery_request_value() { printf "%s\\n" "$request_identity"; }',
      'sleep() { request_identity="v1 $HERMES_GATEWAY_RECOVERY_GENERATION"; }',
      extractShellFunction(source, "wait_for_hermes_gateway_recovery_request"),
      "wait_for_hermes_gateway_recovery_request",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("awaiting gated host recovery");
    expect(result.stderr).toContain("Gated host recovery requested");
  });

  it("accepts a matching gated request already published before polling", () => {
    const script = [
      "set -uo pipefail",
      'publish_hermes_gateway_recovery_generation() { HERMES_GATEWAY_RECOVERY_GENERATION="$(printf b%.0s {1..64})"; request_identity="v1 $HERMES_GATEWAY_RECOVERY_GENERATION"; }',
      'hermes_gateway_recovery_request_value() { printf "%s\\n" "$request_identity"; }',
      'sleep() { printf "%s\\n" "controller-handoff-complete"; }',
      extractShellFunction(source, "wait_for_hermes_gateway_recovery_request"),
      "wait_for_hermes_gateway_recovery_request",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("controller-handoff-complete");
    expect(result.stderr).toContain("Gated host recovery requested");
  });

  it("rejects an untrusted recovery request marker", () => {
    const script = [
      "set -uo pipefail",
      `HERMES_GATEWAY_RECOVERY_REQUEST_FILE=${JSON.stringify(START_SCRIPT)}`,
      "stat() { printf '%s\\n' '501:20:644:1:1:2'; }",
      extractShellFunction(source, "hermes_gateway_recovery_request_value"),
      "hermes_gateway_recovery_request_value",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recovery request metadata is unsafe");
  });

  it("relaunches exactly once for Hermes EX_TEMPFAIL and preserves the entrypoint", () => {
    const result = runSupervisor(75, 9);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "status=9 waits=2 launches=1 marks=1 ready=1 auxiliaries=1 finalize=1 refresh=1 recoveries=0 gateway=101",
    );
    expect(result.stderr).toContain("Hermes requested a service-managed restart");
  });

  it("holds a clean exit until gated host recovery requests a relaunch", () => {
    const result = runSupervisor(0, 9);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "status=9 waits=2 launches=1 marks=1 ready=1 auxiliaries=1 finalize=1 refresh=1 recoveries=1 gateway=101",
    );
    expect(result.stderr).not.toContain("service-managed restart");
  });

  it.each([1, 74, 76])("does not relaunch for non-restart exit %i", (exitCode) => {
    const result = runSupervisor(exitCode, 9);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      `status=${exitCode} waits=1 launches=0 marks=0 ready=0 auxiliaries=0 finalize=0 refresh=0 recoveries=0 gateway=100`,
    );
  });
});
