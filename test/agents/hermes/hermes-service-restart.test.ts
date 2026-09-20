// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { extractShellFunction } from "../../support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");
const source = fs.readFileSync(START_SCRIPT, "utf8");

function runSupervisor(firstExit: number, finalExit: number, repeatedFirstExits = 1) {
  const script = [
    "set -uo pipefail",
    "readonly HERMES_SERVICE_RESTART_STATUS=75",
    "readonly HERMES_GATEWAY_RECOVERY_STATUS=79",
    "readonly HERMES_SERVICE_RESTART_MAX=5",
    "readonly HERMES_SERVICE_RESTART_WINDOW_SECONDS=60",
    "GATEWAY_PID=100",
    'GATEWAY_PID_START_IDENTITY="start-100"',
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
    `repeated_first_exits=${repeatedFirstExits}`,
    'wait() { wait_count=$((wait_count + 1)); if [ "$wait_count" -le "$repeated_first_exits" ]; then return "$first_exit"; fi; return "$final_exit"; }',
    "mark_hermes_gateway_stopped() { mark_count=$((mark_count + 1)); }",
    'launch_hermes_gateway_current_user() { launch_count=$((launch_count + 1)); GATEWAY_PID=$((GATEWAY_PID + 1)); GATEWAY_PID_START_IDENTITY="start-$GATEWAY_PID"; }',
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
      "readonly HERMES_GATEWAY_RECOVERY_REQUESTER_EXIT_ATTEMPTS=30",
      "readonly HERMES_GATEWAY_RECOVERY_REQUEST_WAIT_SECONDS=120",
      "readonly HERMES_GATEWAY_RECOVERY_TRANSPORT_SETTLE_SECONDS=1",
      'request_identity="v2 $(printf d%.0s {1..64}) 321 654"',
      'publish_hermes_gateway_recovery_generation() { HERMES_GATEWAY_RECOVERY_GENERATION="$(printf a%.0s {1..64})"; }',
      'hermes_gateway_recovery_request_value() { printf "%s\\n" "$request_identity"; }',
      "hermes_recovery_requester_start_time() { return 1; }",
      'sleep() { request_identity="v2 $HERMES_GATEWAY_RECOVERY_GENERATION 321 654"; }',
      extractShellFunction(source, "wait_for_hermes_recovery_requester_exit"),
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
      "readonly HERMES_GATEWAY_RECOVERY_REQUESTER_EXIT_ATTEMPTS=30",
      "readonly HERMES_GATEWAY_RECOVERY_REQUEST_WAIT_SECONDS=120",
      "readonly HERMES_GATEWAY_RECOVERY_TRANSPORT_SETTLE_SECONDS=1",
      "sleep_count=0",
      'publish_hermes_gateway_recovery_generation() { HERMES_GATEWAY_RECOVERY_GENERATION="$(printf b%.0s {1..64})"; request_identity="v2 $HERMES_GATEWAY_RECOVERY_GENERATION 321 654"; }',
      'hermes_gateway_recovery_request_value() { printf "%s\\n" "$request_identity"; }',
      "hermes_recovery_requester_start_time() { return 1; }",
      "sleep() { sleep_count=$((sleep_count + 1)); }",
      extractShellFunction(source, "wait_for_hermes_recovery_requester_exit"),
      extractShellFunction(source, "wait_for_hermes_gateway_recovery_request"),
      "wait_for_hermes_gateway_recovery_request",
      'printf "%s\\n" "$sleep_count"',
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("1");
    expect(result.stderr).toContain("Gated host recovery requested");
  });

  it("waits for the exact recovery controller process to exit before relaunch", () => {
    const script = [
      "set -uo pipefail",
      "readonly HERMES_GATEWAY_RECOVERY_REQUESTER_EXIT_ATTEMPTS=30",
      "readonly HERMES_GATEWAY_RECOVERY_REQUEST_WAIT_SECONDS=120",
      "readonly HERMES_GATEWAY_RECOVERY_TRANSPORT_SETTLE_SECONDS=1",
      'probe_count_file="$(mktemp)"',
      'printf "%s\\n" 0 >"$probe_count_file"',
      'publish_hermes_gateway_recovery_generation() { HERMES_GATEWAY_RECOVERY_GENERATION="$(printf c%.0s {1..64})"; request_identity="v2 $HERMES_GATEWAY_RECOVERY_GENERATION 321 654"; }',
      'hermes_gateway_recovery_request_value() { printf "%s\\n" "$request_identity"; }',
      'hermes_recovery_requester_start_time() { count="$(cat "$probe_count_file")"; count=$((count + 1)); printf "%s\\n" "$count" >"$probe_count_file"; if [ "$count" -lt 3 ]; then printf "%s" 654; else return 1; fi; }',
      'sleep() { printf "sleep:%s\\n" "$(cat "$probe_count_file")" >&2; }',
      extractShellFunction(source, "wait_for_hermes_recovery_requester_exit"),
      extractShellFunction(source, "wait_for_hermes_gateway_recovery_request"),
      "wait_for_hermes_gateway_recovery_request",
      'cat "$probe_count_file"',
      'rm -f "$probe_count_file"',
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("3");
    expect(result.stderr).toContain("sleep:3");
    expect(result.stderr.indexOf("sleep:3")).toBeLessThan(
      result.stderr.indexOf("Gated host recovery requested"),
    );
    expect(result.stderr).toContain("Gated host recovery requested");
  });

  it("does not authorize relaunch when controller transport settlement fails", () => {
    const script = [
      "set -uo pipefail",
      "readonly HERMES_GATEWAY_RECOVERY_REQUESTER_EXIT_ATTEMPTS=30",
      "readonly HERMES_GATEWAY_RECOVERY_REQUEST_WAIT_SECONDS=120",
      "readonly HERMES_GATEWAY_RECOVERY_TRANSPORT_SETTLE_SECONDS=1",
      'publish_hermes_gateway_recovery_generation() { HERMES_GATEWAY_RECOVERY_GENERATION="$(printf c%.0s {1..64})"; request_identity="v2 $HERMES_GATEWAY_RECOVERY_GENERATION 321 654"; }',
      'hermes_gateway_recovery_request_value() { printf "%s\\n" "$request_identity"; }',
      "hermes_recovery_requester_start_time() { return 1; }",
      "sleep() { return 1; }",
      extractShellFunction(source, "wait_for_hermes_recovery_requester_exit"),
      extractShellFunction(source, "wait_for_hermes_gateway_recovery_request"),
      "wait_for_hermes_gateway_recovery_request",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("controller transport did not settle");
    expect(result.stderr).not.toContain("relaunching");
  });

  it("does not authorize relaunch when the recovery controller does not exit", () => {
    const script = [
      "set -uo pipefail",
      "readonly HERMES_GATEWAY_RECOVERY_REQUESTER_EXIT_ATTEMPTS=2",
      "readonly HERMES_GATEWAY_RECOVERY_REQUEST_WAIT_SECONDS=120",
      "readonly HERMES_GATEWAY_RECOVERY_TRANSPORT_SETTLE_SECONDS=1",
      'publish_hermes_gateway_recovery_generation() { HERMES_GATEWAY_RECOVERY_GENERATION="$(printf c%.0s {1..64})"; request_identity="v2 $HERMES_GATEWAY_RECOVERY_GENERATION 321 654"; }',
      'hermes_gateway_recovery_request_value() { printf "%s\\n" "$request_identity"; }',
      'hermes_recovery_requester_start_time() { printf "%s" 654; }',
      "sleep() { :; }",
      extractShellFunction(source, "wait_for_hermes_recovery_requester_exit"),
      extractShellFunction(source, "wait_for_hermes_gateway_recovery_request"),
      "wait_for_hermes_gateway_recovery_request",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("controller did not exit");
    expect(result.stderr).not.toContain("relaunching");
  });

  it("does not authorize relaunch when the controller identity remains unreadable", () => {
    const script = [
      "set -uo pipefail",
      "readonly HERMES_GATEWAY_RECOVERY_REQUESTER_EXIT_ATTEMPTS=2",
      "readonly HERMES_GATEWAY_RECOVERY_REQUEST_WAIT_SECONDS=120",
      "readonly HERMES_GATEWAY_RECOVERY_TRANSPORT_SETTLE_SECONDS=1",
      'publish_hermes_gateway_recovery_generation() { HERMES_GATEWAY_RECOVERY_GENERATION="$(printf c%.0s {1..64})"; request_identity="v2 $HERMES_GATEWAY_RECOVERY_GENERATION 321 654"; }',
      'hermes_gateway_recovery_request_value() { printf "%s\\n" "$request_identity"; }',
      "hermes_recovery_requester_start_time() { return 2; }",
      "sleep() { :; }",
      extractShellFunction(source, "wait_for_hermes_recovery_requester_exit"),
      extractShellFunction(source, "wait_for_hermes_gateway_recovery_request"),
      "wait_for_hermes_gateway_recovery_request",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("controller did not exit");
    expect(result.stderr).not.toContain("relaunching");
  });

  it("stops when no gated recovery request arrives before the deadline", () => {
    const script = [
      "set -uo pipefail",
      "readonly HERMES_GATEWAY_RECOVERY_REQUESTER_EXIT_ATTEMPTS=30",
      "readonly HERMES_GATEWAY_RECOVERY_REQUEST_WAIT_SECONDS=2",
      "readonly HERMES_GATEWAY_RECOVERY_TRANSPORT_SETTLE_SECONDS=1",
      "sleep_count=0",
      'publish_hermes_gateway_recovery_generation() { HERMES_GATEWAY_RECOVERY_GENERATION="$(printf c%.0s {1..64})"; }',
      'hermes_gateway_recovery_request_value() { printf "%s\\n" absent; }',
      "hermes_recovery_requester_start_time() { return 1; }",
      "sleep() { sleep_count=$((sleep_count + 1)); }",
      extractShellFunction(source, "wait_for_hermes_recovery_requester_exit"),
      extractShellFunction(source, "wait_for_hermes_gateway_recovery_request"),
      "status=0",
      "wait_for_hermes_gateway_recovery_request || status=$?",
      'printf "status=%s sleeps=%s\\n" "$status" "$sleep_count"',
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("status=1 sleeps=2");
    expect(result.stderr).toContain("recovery request timed out after 2 seconds");
    expect(result.stderr).toContain("nemoclaw <name> stop");
    expect(result.stderr).toContain("nemoclaw <name> start");
    expect(result.stderr).not.toContain("relaunching");
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

  it("accepts a generation-bound recovery controller identity", () => {
    const script = [
      "set -uo pipefail",
      'HERMES_GATEWAY_RECOVERY_REQUEST_FILE="$(mktemp)"',
      "trap 'rm -f \"$HERMES_GATEWAY_RECOVERY_REQUEST_FILE\"' EXIT",
      'request="v2 $(printf a%.0s {1..64}) 321 654"',
      'printf "%s\\n" "$request" >"$HERMES_GATEWAY_RECOVERY_REQUEST_FILE"',
      "stat() { printf '%s\\n' '0:0:444:1:1:2'; }",
      extractShellFunction(source, "hermes_gateway_recovery_request_value"),
      "hermes_gateway_recovery_request_value",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`v2 ${"a".repeat(64)} 321 654`);
  });

  it("rejects a recovery request that names PID 1", () => {
    const script = [
      "set -uo pipefail",
      'HERMES_GATEWAY_RECOVERY_REQUEST_FILE="$(mktemp)"',
      "trap 'rm -f \"$HERMES_GATEWAY_RECOVERY_REQUEST_FILE\"' EXIT",
      'printf "v2 %s 1 654\\n" "$(printf a%.0s {1..64})" >"$HERMES_GATEWAY_RECOVERY_REQUEST_FILE"',
      "stat() { printf '%s\\n' '0:0:444:1:1:2'; }",
      extractShellFunction(source, "hermes_gateway_recovery_request_value"),
      "hermes_gateway_recovery_request_value",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requester identity is invalid");
  });

  it("relaunches exactly once for Hermes EX_TEMPFAIL and preserves the entrypoint", () => {
    const result = runSupervisor(75, 9);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "status=9 waits=2 launches=1 marks=1 ready=1 auxiliaries=1 finalize=1 refresh=1 recoveries=0 gateway=101",
    );
    expect(result.stderr).toContain("Hermes requested a service-managed restart");
  });

  it("stops after five service-managed restart requests within 60 seconds without launching a sixth gateway", () => {
    const result = runSupervisor(75, 9, 5);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "status=1 waits=5 launches=4 marks=4 ready=4 auxiliaries=4 finalize=4 refresh=4 recoveries=0 gateway=104",
    );
    expect(result.stderr).toContain("Hermes gateway pid 104 start identity start-104");
    expect(result.stderr).toContain("5 service-managed restarts within 60 seconds");
    expect(result.stderr).toContain("nemoclaw <name> stop");
    expect(result.stderr).toContain("nemoclaw <name> start");
    expect(result.stderr).toContain("reset the supervisor");
  });

  it("holds a clean exit until gated host recovery requests a relaunch", () => {
    const result = runSupervisor(0, 9);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "status=9 waits=2 launches=1 marks=1 ready=1 auxiliaries=1 finalize=1 refresh=1 recoveries=1 gateway=101",
    );
    expect(result.stderr).not.toContain("service-managed restart");
  });

  it("holds the private recovery exit until gated host recovery requests a relaunch", () => {
    const result = runSupervisor(79, 9);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "status=9 waits=2 launches=1 marks=1 ready=1 auxiliaries=1 finalize=1 refresh=1 recoveries=1 gateway=101",
    );
    expect(result.stderr).not.toContain("service-managed restart");
  });

  it.each([1, 74, 76, 78, 137, 143])("does not relaunch for non-restart exit %i", (exitCode) => {
    const result = runSupervisor(exitCode, 9);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      `status=${exitCode} waits=1 launches=0 marks=0 ready=0 auxiliaries=0 finalize=0 refresh=0 recoveries=0 gateway=100`,
    );
  });
});
