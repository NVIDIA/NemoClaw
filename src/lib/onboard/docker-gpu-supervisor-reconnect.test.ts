// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getDockerGpuSupervisorReconnectErrorDebouncePolls,
  getDockerGpuSupervisorReconnectTimeoutSecs,
  waitForOpenShellFinalHandoff,
  waitForOpenShellSupervisorReconnect,
} from "./docker-gpu-supervisor-reconnect";

describe("Docker GPU supervisor reconnect", () => {
  it("does not report reconnect without an OpenShell execution boundary (#9531)", () => {
    expect(waitForOpenShellSupervisorReconnect("alpha", 1, { sleep: vi.fn() })).toBe(false);
  });
});

describe("Docker GPU final handoff acknowledgement", () => {
  it("accepts the exact running replacement only after OpenShell reports Ready (#9531)", () => {
    const events: string[] = [];
    const runCaptureOpenshell = vi
      .fn()
      .mockImplementationOnce(() => {
        events.push("observe provisioning");
        return "alpha  2026-08-23 10:00:00  Provisioning\n";
      })
      .mockImplementationOnce(() => {
        events.push("observe ready");
        return "alpha  2026-08-23 10:00:02  Ready\n";
      });
    const runOpenshell = vi.fn(() => {
      events.push("exec ready");
      return { status: 0 };
    });
    const replacementIsExactAndRunning = vi.fn(() => {
      events.push("confirm exact replacement");
      return true;
    });

    const acknowledgement = waitForOpenShellFinalHandoff("alpha", 60, {
      runCaptureOpenshell,
      runOpenshell,
      replacementIsExactAndRunning,
      sleep: vi.fn(),
    });

    expect(acknowledgement).toEqual({ acknowledged: true, lastSandboxPhase: "Ready" });
    expect(events).toEqual([
      "observe provisioning",
      "confirm exact replacement",
      "observe ready",
      "exec ready",
      "confirm exact replacement",
    ]);
    expect(runCaptureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "list"],
      expect.objectContaining({
        killProcessTreeOnTimeout: true,
        killSignal: "SIGKILL",
        timeout: expect.any(Number),
      }),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "exec", "-n", "alpha", "--", "true"],
      expect.objectContaining({
        killProcessTreeOnTimeout: true,
        killSignal: "SIGKILL",
        timeout: expect.any(Number),
      }),
    );
  });

  it("treats Deleting after the replacement start as terminal (#9531)", () => {
    const runCaptureOpenshell = vi.fn(() => "alpha  2026-08-23 10:00:00  Deleting\n");
    const runOpenshell = vi.fn(() => ({ status: 1 }));
    const replacementIsExactAndRunning = vi.fn(() => true);
    const sleep = vi.fn();

    expect(
      waitForOpenShellFinalHandoff("alpha", 60, {
        runCaptureOpenshell,
        runOpenshell,
        replacementIsExactAndRunning,
        sleep,
      }),
    ).toEqual({ acknowledged: false, lastSandboxPhase: "Deleting" });
    expect(runCaptureOpenshell).toHaveBeenCalledOnce();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(replacementIsExactAndRunning).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("continues through Error only while the exact replacement is running (#9531)", () => {
    const runCaptureOpenshell = vi.fn(() => "alpha  2026-08-23 10:00:00  Error\n");
    const replacementIsExactAndRunning = vi.fn(() => false);

    expect(
      waitForOpenShellFinalHandoff("alpha", 60, {
        runCaptureOpenshell,
        runOpenshell: vi.fn(() => ({ status: 1 })),
        replacementIsExactAndRunning,
        sleep: vi.fn(),
      }),
    ).toEqual({ acknowledged: false, lastSandboxPhase: "Error" });
    expect(replacementIsExactAndRunning).toHaveBeenCalledOnce();
  });

  it("allows a running replacement to progress from Error to Ready (#9531)", () => {
    const runCaptureOpenshell = vi
      .fn()
      .mockReturnValueOnce("alpha  2026-08-23 10:00:00  Error\n")
      .mockReturnValueOnce("alpha  2026-08-23 10:00:02  Ready\n");
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const replacementIsExactAndRunning = vi.fn(() => true);

    expect(
      waitForOpenShellFinalHandoff("alpha", 60, {
        runCaptureOpenshell,
        runOpenshell,
        replacementIsExactAndRunning,
        sleep: vi.fn(),
      }),
    ).toEqual({ acknowledged: true, lastSandboxPhase: "Ready" });
    expect(replacementIsExactAndRunning).toHaveBeenCalledTimes(2);
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("does not reuse a stale Ready phase after the sandbox row disappears (#9531)", () => {
    const runCaptureOpenshell = vi
      .fn()
      .mockReturnValueOnce("alpha  2026-08-23 10:00:00  Ready\n")
      .mockReturnValue("");
    const runOpenshell = vi.fn(() => ({ status: 1 }));
    const replacementIsExactAndRunning = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

    expect(
      waitForOpenShellFinalHandoff("alpha", 60, {
        runCaptureOpenshell,
        runOpenshell,
        replacementIsExactAndRunning,
        sleep: vi.fn(),
      }),
    ).toEqual({ acknowledged: false, lastSandboxPhase: "Ready" });
    expect(runOpenshell).toHaveBeenCalledOnce();
  });
});

// The Docker GPU patch supervisor-reconnect wait must absorb a transient
// Error phase reported while OpenShell's sandbox-list cache catches up to
// the newly-recreated GPU container. The old-container teardown briefly
// marks the row Error before the host re-registers the new container.
// Without debouncing, the fast-fail short-circuits within ~12s on a healthy
// GPU sandbox whose container is running and whose supervisor has already
// logged `LIFECYCLE:INSTALL OpenShell Sandbox Supervisor success`.
describe("docker-gpu-supervisor-reconnect Error-phase debounce", () => {
  it("uses a Docker-GPU-specific supervisor reconnect wait with an override", () => {
    expect(getDockerGpuSupervisorReconnectTimeoutSecs(180, {})).toBe(900);
    expect(getDockerGpuSupervisorReconnectTimeoutSecs(600, {})).toBe(900);
    expect(getDockerGpuSupervisorReconnectTimeoutSecs(1200, {})).toBe(1200);
    expect(
      getDockerGpuSupervisorReconnectTimeoutSecs(180, {
        NEMOCLAW_DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT: "30",
      }),
    ).toBe(30);
  });

  it("short-circuits the supervisor-reconnect wait when the sandbox enters Error phase", () => {
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "sandbox not ready" }));
    const listOutputs = [
      "alpha   Provisioning   1s ago",
      "alpha   \u001b[31mError\u001b[0m          3s ago",
    ];
    let index = 0;
    const runCaptureOpenshell = vi.fn(() => listOutputs[Math.min(index++, listOutputs.length - 1)]);
    const sleep = vi.fn();

    const ok = waitForOpenShellSupervisorReconnect("alpha", 600, {
      runOpenshell,
      runCaptureOpenshell,
      sleep,
      errorPhaseDebouncePolls: 1,
    });

    expect(ok).toBe(false);
    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

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

  it("does not accept a supervisor exec with no exit status", () => {
    const runOpenshell = vi.fn(() => ({ status: null, stderr: "timed out" }));
    const runCaptureOpenshell = vi.fn(() => "alpha   Error   1s ago");

    const ok = waitForOpenShellSupervisorReconnect("alpha", 600, {
      runOpenshell,
      runCaptureOpenshell,
      sleep: vi.fn(),
      errorPhaseDebouncePolls: 1,
    });

    expect(ok).toBe(false);
    expect(runOpenshell).toHaveBeenCalledOnce();
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back to the env-backed default when an injected override is non-finite [case %#]",
    (bogus) => {
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
    },
  );
});
