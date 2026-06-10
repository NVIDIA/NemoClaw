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
    const runOpenshell = vi.fn(() => execOutputs[Math.min(execIdx++, execOutputs.length - 1)]);
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

  it("absorbs a Docker-CDI Error phase longer than the old 30s window", () => {
    // #4948 runtime validation on the Docker-CDI GPU runner showed the
    // sandbox-list row can remain Error for roughly a minute after the CDI
    // recreate (`--device nvidia.com/gpu=all`) while the supervisor is still
    // reconnecting. The default debounce must therefore outlive the old
    // 15-poll / ~30s fast-fail window.
    let polls = 0;
    const runOpenshell = vi.fn(() => {
      polls += 1;
      return polls <= 30 ? { status: 1, stderr: "sandbox not ready" } : { status: 0 };
    });
    const runCaptureOpenshell = vi.fn(() =>
      polls <= 30 ? "alpha   Error   1s ago" : "alpha   Ready   65s ago",
    );
    const sleep = vi.fn();

    const ok = waitForOpenShellSupervisorReconnect("alpha", 600, {
      runOpenshell,
      runCaptureOpenshell,
      sleep,
    });

    expect(ok).toBe(true);
    expect(runOpenshell).toHaveBeenCalledTimes(31);
  });

  it("defaults the debounce to 60 polls and honors the env override", () => {
    expect(getDockerGpuSupervisorReconnectErrorDebouncePolls({})).toBe(60);
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

  it("clamps an injected debounce override to the same minimum as the env path", () => {
    // 0 / negative / fractional overrides must not bypass the ≥1 contract that
    // the env-backed helper enforces.
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "sandbox not ready" }));
    const runCaptureOpenshell = vi.fn(() => "alpha   Error   1s ago");
    const sleep = vi.fn();

    const ok = waitForOpenShellSupervisorReconnect("alpha", 600, {
      runOpenshell,
      runCaptureOpenshell,
      sleep,
      errorPhaseDebouncePolls: 0,
    });

    expect(ok).toBe(false);
    // Clamped to K=1: first Error poll short-circuits with no preceding sleep.
    expect(runOpenshell).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("falls back to the env-backed default when an injected override is non-finite", () => {
    // NaN / +Infinity / -Infinity overrides must not silently neutralise the
    // fast-fail loop. A NaN comparison would always be false and `Infinity`
    // would never satisfy `>= debouncePolls`, leaving the wait to burn the
    // full timeout window.
    for (const bogus of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const runOpenshell = vi.fn(() => ({ status: 1, stderr: "sandbox not ready" }));
      const runCaptureOpenshell = vi.fn(() => "alpha   Error   1s ago");
      const sleep = vi.fn();

      const ok = waitForOpenShellSupervisorReconnect("alpha", 600, {
        runOpenshell,
        runCaptureOpenshell,
        sleep,
        errorPhaseDebouncePolls: bogus,
      });

      expect(ok).toBe(false);
      // Default K=60 from the env-backed helper: 60 polls + 59 sleeps before fast-fail.
      expect(runOpenshell).toHaveBeenCalledTimes(60);
      expect(sleep).toHaveBeenCalledTimes(59);
    }
  });
});
