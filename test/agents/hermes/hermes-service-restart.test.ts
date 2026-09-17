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
    `first_exit=${firstExit}`,
    `final_exit=${finalExit}`,
    'wait() { wait_count=$((wait_count + 1)); if [ "$wait_count" -eq 1 ]; then return "$first_exit"; fi; return "$final_exit"; }',
    "mark_hermes_gateway_stopped() { mark_count=$((mark_count + 1)); }",
    "launch_hermes_gateway_current_user() { launch_count=$((launch_count + 1)); GATEWAY_PID=$((GATEWAY_PID + 1)); }",
    "wait_for_hermes_gateway_internal() { ready_count=$((ready_count + 1)); }",
    "ensure_hermes_supervised_auxiliaries() { auxiliary_count=$((auxiliary_count + 1)); }",
    "finalize_tirith_marker_retry() { finalize_count=$((finalize_count + 1)); }",
    "refresh_hermes_supervised_child_pids() { refresh_count=$((refresh_count + 1)); }",
    extractShellFunction(source, "supervise_hermes_service_restarts_current_user"),
    "status=0",
    "supervise_hermes_service_restarts_current_user || status=$?",
    'printf "%s\\n" "status=$status waits=$wait_count launches=$launch_count marks=$mark_count ready=$ready_count auxiliaries=$auxiliary_count finalize=$finalize_count refresh=$refresh_count gateway=$GATEWAY_PID"',
  ].join("\n");
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    timeout: 5_000,
  });
}

describe("Hermes native service restart supervision", () => {
  it("relaunches exactly once for Hermes EX_TEMPFAIL and preserves the entrypoint", () => {
    const result = runSupervisor(75, 9);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "status=9 waits=2 launches=1 marks=1 ready=1 auxiliaries=1 finalize=1 refresh=1 gateway=101",
    );
    expect(result.stderr).toContain("Hermes requested a service-managed restart");
  });

  it.each([0, 1, 74, 76])("does not relaunch for non-restart exit %i", (exitCode) => {
    const result = runSupervisor(exitCode, 9);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      `status=${exitCode} waits=1 launches=0 marks=0 ready=0 auxiliaries=0 finalize=0 refresh=0 gateway=100`,
    );
  });
});
