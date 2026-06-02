// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getDockerGpuSupervisorReconnectErrorDebouncePolls,
  waitForOpenShellSupervisorReconnect,
} from "../../../dist/lib/onboard/docker-gpu-supervisor-reconnect";

// The Docker GPU patch supervisor-reconnect wait must absorb a transient
// Error phase reported while OpenShell's sandbox-list cache catches up to
// the newly-recreated GPU container. The old-container teardown briefly
// marks the row Error before the host re-registers the new container.
// Without debouncing, the fast-fail short-circuits within ~12s on a healthy
// GPU sandbox whose container is running and whose supervisor has already
// logged `LIFECYCLE:INSTALL OpenShell Sandbox Supervisor success`.
describe("docker-gpu-supervisor-reconnect Error-phase debounce", () => {
  it("absorbs a transient Error phase shorter than the debounce window", () => {
    const execOutputs = [
      { status: 1, stderr: "sandbox not ready" },
      { status: 1, stderr: "sandbox not ready" },
      { status: 1, stderr: "sandbox not ready" },
      { status: 0, stdout: "" },
    ];
    let execIdx = 0;
    const runOpenshell = vi.fn(
      () => execOutputs[Math.min(execIdx++, execOutputs.length - 1)],
    );
    const listOutputs = [
      "alpha   Error         1s ago",
      "alpha   Error         3s ago",
      "alpha   Provisioning  5s ago",
      "alpha   Ready         7s ago",
    ];
    let listIdx = 0;
    const runCaptureOpenshell = vi.fn(
      () => listOutputs[Math.min(listIdx++, listOutputs.length - 1)],
    );
    const sleep = vi.fn();

    const ok = waitForOpenShellSupervisorReconnect("alpha", 600, {
      runOpenshell,
      runCaptureOpenshell,
      sleep,
      errorPhaseDebouncePolls: 5,
    });

    expect(ok).toBe(true);
    expect(runOpenshell).toHaveBeenCalledTimes(4);
  });

  it("still fast-fails when Error phase persists for the full debounce window", () => {
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "sandbox not ready" }));
    const runCaptureOpenshell = vi.fn(() => "alpha   Error   1s ago");
    const sleep = vi.fn();

    const ok = waitForOpenShellSupervisorReconnect("alpha", 600, {
      runOpenshell,
      runCaptureOpenshell,
      sleep,
      errorPhaseDebouncePolls: 3,
    });

    expect(ok).toBe(false);
    // Three consecutive Error polls trigger the short-circuit on poll 3.
    // Sleeps happen only between polls 1->2 and 2->3, so two sleeps total.
    expect(runOpenshell).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("resets the consecutive-Error counter when the phase recovers", () => {
    // Error, Error, Provisioning (counter resets), Error, Error, Error
    // -> bails out on the 3rd post-recovery Error, not earlier.
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "sandbox not ready" }));
    const listOutputs = [
      "alpha   Error         1s ago",
      "alpha   Error         3s ago",
      "alpha   Provisioning  5s ago",
      "alpha   Error         7s ago",
      "alpha   Error         9s ago",
      "alpha   Error         11s ago",
    ];
    let listIdx = 0;
    const runCaptureOpenshell = vi.fn(
      () => listOutputs[Math.min(listIdx++, listOutputs.length - 1)],
    );
    const sleep = vi.fn();

    const ok = waitForOpenShellSupervisorReconnect("alpha", 600, {
      runOpenshell,
      runCaptureOpenshell,
      sleep,
      errorPhaseDebouncePolls: 3,
    });

    expect(ok).toBe(false);
    expect(runOpenshell).toHaveBeenCalledTimes(6);
  });

  it("defaults the debounce to 5 polls and honors the env override", () => {
    expect(getDockerGpuSupervisorReconnectErrorDebouncePolls({})).toBe(5);
    expect(
      getDockerGpuSupervisorReconnectErrorDebouncePolls({
        NEMOCLAW_DOCKER_GPU_SUPERVISOR_RECONNECT_ERROR_DEBOUNCE: "2",
      }),
    ).toBe(2);
    // Non-positive values are clamped to a minimum of 1.
    expect(
      getDockerGpuSupervisorReconnectErrorDebouncePolls({
        NEMOCLAW_DOCKER_GPU_SUPERVISOR_RECONNECT_ERROR_DEBOUNCE: "0",
      }),
    ).toBe(1);
  });
});
