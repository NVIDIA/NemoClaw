// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  namedOpenShellGateway,
  type OpenShellSandboxObserver,
  type OpenShellSandboxReadinessProbe,
} from "../adapters/openshell/sandbox-observer";
import {
  pendingSandboxFrame,
  readySandboxFrame,
  replaySandboxObservations,
  terminalSandboxFrame,
  type SandboxObservationFrame,
} from "./__test-helpers__/sandbox-observer-replay";
import {
  createCliSandboxReadyWaiter,
  createSandboxReadyWaiter,
  formatCreatedSandboxReadinessFailureMessage,
  getSandboxReadyErrorDebouncePolls,
  SANDBOX_READY_ERROR_DEBOUNCE_ENV,
  waitForCreatedSandboxReadyWithTrace,
} from "./sandbox-readiness-tracing";

const NAME = "my-sandbox";
const TARGET = namedOpenShellGateway("nemoclaw");
const REJECTED_OBSERVATION_ERROR = {
  kind: "command" as const,
  reason: "failed" as const,
  message: "OpenShell sandbox observation failed before returning a result.",
};

function replay(frames: readonly SandboxObservationFrame[]) {
  return replaySandboxObservations(NAME, frames);
}

describe("createSandboxReadyWaiter", () => {
  it("reads the authoritative gateway name for each CLI-backed wait (#9803)", async () => {
    let gatewayName = "nemoclaw";
    const capture = vi.fn((_args: string[]) => ({
      status: 0,
      output: `${NAME} Ready`,
      stdout: `${NAME} Ready`,
      stderr: "",
    }));
    const waitForSandboxReady = createCliSandboxReadyWaiter({
      capture,
      getGatewayName: () => gatewayName,
      isLinuxDockerDriverGatewayEnabled: () => true,
      sleep: vi.fn(),
    });

    await expect(waitForSandboxReady(NAME, 1, 0)).resolves.toEqual({
      ready: true,
      reason: "ready",
      error: null,
    });
    gatewayName = "nemoclaw-18080";
    await expect(waitForSandboxReady(NAME, 1, 0)).resolves.toEqual({
      ready: true,
      reason: "ready",
      error: null,
    });

    expect(capture.mock.calls.map(([args]) => args)).toEqual([
      ["sandbox", "list", "-g", "nemoclaw"],
      ["sandbox", "list", "-g", "nemoclaw-18080"],
    ]);
  });

  it("uses the legacy Docker-driver poll settings as an adaptive deadline budget", async () => {
    const { observer, listSandboxes } = replay([pendingSandboxFrame("Provisioning")]);
    const sleep = vi.fn();
    const waitForSandboxReady = createSandboxReadyWaiter({
      observer,
      target: TARGET,
      isLinuxDockerDriverGatewayEnabled: () => true,
      sleep,
      now: () => 0,
    });

    await expect(waitForSandboxReady(NAME, 2, 3)).resolves.toEqual({
      ready: false,
      reason: "timeout",
      error: null,
    });
    expect(listSandboxes).toHaveBeenCalledTimes(7);
    const observationTimeouts = listSandboxes.mock.calls.map(([request]) => request.timeoutMs);
    expect(listSandboxes).toHaveBeenCalledWith(expect.objectContaining({ target: TARGET }));
    expect(observationTimeouts[0]).toBe(6_000);
    expect(
      observationTimeouts.every(
        (timeoutMs, index) => index === 0 || timeoutMs! < observationTimeouts[index - 1]!,
      ),
    ).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(7);
    expect(sleep).toHaveBeenNthCalledWith(1, 0.25);
    expect(sleep.mock.calls.reduce((total, [seconds]) => total + seconds, 0)).toBeCloseTo(6, 2);
    expect(Math.max(...sleep.mock.calls.map(([seconds]) => seconds))).toBeLessThanOrEqual(3);
  });

  it("uses the same deadline for the legacy Kubernetes pod fallback", async () => {
    const { observer, listSandboxes } = replay([pendingSandboxFrame("Provisioning")]);
    const fallbackReadinessProbe = vi.fn<OpenShellSandboxReadinessProbe>(async () => ({
      ok: true,
      value: "not_ready",
    }));
    const sleep = vi.fn();
    const waitForSandboxReady = createSandboxReadyWaiter({
      observer,
      target: TARGET,
      fallbackReadinessProbe,
      isLinuxDockerDriverGatewayEnabled: () => false,
      sleep,
    });

    await expect(waitForSandboxReady(NAME, 1, 2)).resolves.toEqual({
      ready: false,
      reason: "timeout",
      error: null,
    });
    expect(fallbackReadinessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        target: TARGET,
        sandboxName: NAME,
        timeoutMs: expect.any(Number),
      }),
    );
    const listTimeouts = listSandboxes.mock.calls.map(([request]) => request.timeoutMs);
    const fallbackTimeouts = fallbackReadinessProbe.mock.calls.map(
      ([request]) => request.timeoutMs,
    );
    expect(listTimeouts.length).toBeGreaterThan(0);
    expect(fallbackTimeouts).toHaveLength(listTimeouts.length);
    expect(
      fallbackTimeouts.every(
        (timeoutMs, index) => timeoutMs! > 0 && timeoutMs! <= listTimeouts[index]!,
      ),
    ).toBe(true);
    const totalSleepSeconds = sleep.mock.calls.reduce((total, [seconds]) => total + seconds, 0);
    expect(totalSleepSeconds).toBeGreaterThan(0);
    expect(totalSleepSeconds).toBeLessThanOrEqual(2);
  });

  it("keeps the waiter within its deadline without an extra final delay", async () => {
    const { observer } = replay([pendingSandboxFrame("Provisioning")]);
    const fallbackReadinessProbe = vi.fn(async () => ({
      ok: true as const,
      value: "not_ready" as const,
    }));
    const sleep = vi.fn();

    await expect(
      createSandboxReadyWaiter({
        observer,
        target: TARGET,
        fallbackReadinessProbe,
        isLinuxDockerDriverGatewayEnabled: () => false,
        sleep,
      })(NAME, 1, 2),
    ).resolves.toEqual({ ready: false, reason: "timeout", error: null });
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.reduce((total, [seconds]) => total + seconds, 0)).toBeCloseTo(2, 2);
  });

  it("stops on an authentication failure without using the readiness fallback (#9803)", async () => {
    const error = {
      kind: "authentication" as const,
      message: "OpenShell could not authenticate the sandbox observation.",
    };
    const listSandboxes = vi.fn<OpenShellSandboxObserver["listSandboxes"]>(async () => ({
      ok: false,
      error,
    }));
    const fallbackReadinessProbe = vi.fn();
    const sleep = vi.fn();

    await expect(
      createSandboxReadyWaiter({
        observer: { listSandboxes },
        target: TARGET,
        fallbackReadinessProbe,
        isLinuxDockerDriverGatewayEnabled: () => false,
        sleep,
        now: () => 1_000,
      })(NAME, 10, 2),
    ).resolves.toEqual({ ready: false, reason: "observation_failed", error });
    expect(listSandboxes).toHaveBeenCalledOnce();
    expect(listSandboxes).toHaveBeenCalledWith({ target: TARGET, timeoutMs: 20_000 });
    expect(fallbackReadinessProbe).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns a typed failure when the sandbox observer rejects (#9803)", async () => {
    const listSandboxes = vi
      .fn<OpenShellSandboxObserver["listSandboxes"]>()
      .mockRejectedValue(new Error("untrusted observer diagnostic"));

    const result = await createSandboxReadyWaiter({
      observer: { listSandboxes },
      target: TARGET,
      isLinuxDockerDriverGatewayEnabled: () => true,
      sleep: vi.fn(),
    })(NAME, 1, 2);

    expect(result).toEqual({
      ready: false,
      reason: "observation_failed",
      error: REJECTED_OBSERVATION_ERROR,
    });
    expect(JSON.stringify(result)).not.toContain("untrusted observer diagnostic");
  });

  it("returns a typed failure when the legacy readiness probe rejects (#9803)", async () => {
    const { observer } = replay([pendingSandboxFrame("Provisioning")]);
    const fallbackReadinessProbe = vi
      .fn<OpenShellSandboxReadinessProbe>()
      .mockRejectedValue(new Error("untrusted legacy probe diagnostic"));

    const result = await createSandboxReadyWaiter({
      observer,
      target: TARGET,
      fallbackReadinessProbe,
      isLinuxDockerDriverGatewayEnabled: () => false,
      sleep: vi.fn(),
    })(NAME, 1, 2);

    expect(result).toEqual({
      ready: false,
      reason: "observation_failed",
      error: REJECTED_OBSERVATION_ERROR,
    });
    expect(JSON.stringify(result)).not.toContain("untrusted legacy probe diagnostic");
  });

  it("retries an unreachable gateway observation before accepting Ready (#9803)", async () => {
    const listSandboxes = vi
      .fn<OpenShellSandboxObserver["listSandboxes"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "transport",
          reason: "unreachable",
          message: "OpenShell could not reach the selected gateway.",
        },
      })
      .mockResolvedValue({
        ok: true,
        value: { sandboxes: [{ name: NAME, phase: "Ready", readiness: "ready" }] },
      });
    const sleep = vi.fn();

    await expect(
      createSandboxReadyWaiter({
        observer: { listSandboxes },
        target: TARGET,
        isLinuxDockerDriverGatewayEnabled: () => true,
        sleep,
      })(NAME, 2, 1),
    ).resolves.toEqual({ ready: true, reason: "ready", error: null });
    expect(listSandboxes).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });
});

describe("waitForCreatedSandboxReadyWithTrace terminal-phase handling", () => {
  it("waits for the exact recreated sandbox to become executable before accepting stable Ready (#9050)", async () => {
    const { observer, listSandboxes, sleep } = replay([readySandboxFrame()]);
    const checkReadyIdentity = vi
      .fn()
      .mockResolvedValueOnce("not_ready")
      .mockResolvedValue("ready");

    await expect(
      waitForCreatedSandboxReadyWithTrace({
        sandboxName: NAME,
        timeoutSecs: 30,
        observer,
        target: TARGET,
        stableReadyPolls: 2,
        checkReadyIdentity,
        sleep,
      }),
    ).resolves.toEqual({ ready: true, reason: "ready", failurePhase: null });
    expect(checkReadyIdentity).toHaveBeenCalledTimes(3);
    expect(listSandboxes).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("stops when the recreated sandbox identity changes (#9050)", async () => {
    const { observer, listSandboxes, sleep } = replay([readySandboxFrame()]);

    await expect(
      waitForCreatedSandboxReadyWithTrace({
        sandboxName: NAME,
        timeoutSecs: 30,
        observer,
        target: TARGET,
        checkReadyIdentity: async () => "identity_changed",
        sleep,
      }),
    ).resolves.toEqual({ ready: false, reason: "identity_changed", failurePhase: null });
    expect(listSandboxes).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after an unknown durable-identity probe failure (#9050)", async () => {
    const { observer, listSandboxes, sleep } = replay([readySandboxFrame()]);

    const readiness = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 30,
      observer,
      target: TARGET,
      checkReadyIdentity: async () => "probe_failed",
      sleep,
    });
    expect(readiness).toEqual({
      ready: false,
      reason: "identity_probe_failed",
      failurePhase: null,
    });
    expect(formatCreatedSandboxReadinessFailureMessage(NAME, readiness, 30)).toBe(
      `  NemoClaw could not verify that sandbox '${NAME}' returned a durable ID and accepted commands.`,
    );
    expect(listSandboxes).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not probe when the readiness deadline is zero (#3768)", async () => {
    const { observer, listSandboxes, sleep } = replay([readySandboxFrame()]);

    await expect(
      waitForCreatedSandboxReadyWithTrace({
        sandboxName: NAME,
        timeoutSecs: 0,
        observer,
        target: TARGET,
        sleep,
      }),
    ).resolves.toEqual({ ready: false, reason: "timeout", failurePhase: null });
    expect(listSandboxes).not.toHaveBeenCalled();
  });

  it("stops on a typed observation failure instead of treating it as missing", async () => {
    const error = {
      kind: "authentication" as const,
      message: "OpenShell could not authenticate the sandbox observation.",
    };
    const listSandboxes = vi.fn<OpenShellSandboxObserver["listSandboxes"]>(async () => ({
      ok: false,
      error,
    }));
    const sleep = vi.fn();

    const readiness = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 30,
      observer: { listSandboxes },
      target: TARGET,
      sleep,
      now: () => 1_000,
    });

    expect(readiness).toEqual({
      ready: false,
      reason: "observation_failed",
      failurePhase: null,
      error,
    });
    expect(formatCreatedSandboxReadinessFailureMessage(NAME, readiness, 30)).toContain(
      error.message,
    );
    expect(listSandboxes).toHaveBeenCalledOnce();
    expect(listSandboxes).toHaveBeenCalledWith({ target: TARGET, timeoutMs: 30_000 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns a typed failure when the created-sandbox observer rejects (#9803)", async () => {
    const listSandboxes = vi
      .fn<OpenShellSandboxObserver["listSandboxes"]>()
      .mockRejectedValue(new Error("untrusted created-sandbox diagnostic"));

    const result = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 30,
      observer: { listSandboxes },
      target: TARGET,
      sleep: vi.fn(),
    });

    expect(result).toEqual({
      ready: false,
      reason: "observation_failed",
      failurePhase: null,
      error: REJECTED_OBSERVATION_ERROR,
    });
    expect(JSON.stringify(result)).not.toContain("untrusted created-sandbox diagnostic");
  });

  it("retries a timed-out observation before accepting created-sandbox Ready (#9803)", async () => {
    const listSandboxes = vi
      .fn<OpenShellSandboxObserver["listSandboxes"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "timeout", message: "OpenShell sandbox observation timed out." },
      })
      .mockResolvedValue({
        ok: true,
        value: { sandboxes: [{ name: NAME, phase: "Ready", readiness: "ready" }] },
      });
    const sleep = vi.fn();

    await expect(
      waitForCreatedSandboxReadyWithTrace({
        sandboxName: NAME,
        timeoutSecs: 30,
        observer: { listSandboxes },
        target: TARGET,
        sleep,
      }),
    ).resolves.toEqual({ ready: true, reason: "ready", failurePhase: null });
    expect(listSandboxes).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("fast-fails on the first Error poll when the debounce is opted out (K=1)", async () => {
    const { observer, listSandboxes, sleep } = replay([
      pendingSandboxFrame("Provisioning"),
      terminalSandboxFrame("Error"),
    ]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      // 600 / 2 = 300 readyAttempts. With the K=1 (no-debounce) opt-out we bail
      // out after the 2nd poll, preserving the original fast-fail intent.
      timeoutSecs: 600,
      observer,
      target: TARGET,
      errorPhaseDebouncePolls: 1,
      sleep,
    });

    expect(ready).toEqual({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Error",
    });
    expect(listSandboxes).toHaveBeenCalledTimes(2);
    // Should not sleep after detecting the terminal phase.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("recovers when a transient Error flips to Ready within the debounce window (#6043)", async () => {
    // DGX Spark repro: the gateway re-registers the just-created sandbox and
    // `sandbox list` briefly reports Error before flipping to Ready. The
    // default debounce must tolerate the transient rather than fast-failing.
    const { observer, listSandboxes, sleep } = replay([
      pendingSandboxFrame("Provisioning"),
      terminalSandboxFrame("Error"),
      terminalSandboxFrame("Error"),
      readySandboxFrame(),
    ]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      observer,
      target: TARGET,
      sleep,
    });

    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
    expect(listSandboxes).toHaveBeenCalledTimes(4);
  });

  it("resets the debounce counter when a non-Error poll interrupts the Error streak", async () => {
    // Flapping Error must not accumulate toward the terminal threshold.
    const { observer, sleep } = replay([
      terminalSandboxFrame("Error"),
      pendingSandboxFrame("Provisioning"),
      terminalSandboxFrame("Error"),
      readySandboxFrame(),
    ]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      observer,
      target: TARGET,
      errorPhaseDebouncePolls: 2,
      sleep,
    });

    // Never two consecutive Error polls, so it never crosses the threshold.
    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
  });

  it("still fails terminally after sustained Error exceeds the debounce window (#6043)", async () => {
    const { observer, listSandboxes, sleep } = replay([terminalSandboxFrame("Error")]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      observer,
      target: TARGET,
      errorPhaseDebouncePolls: 3,
      sleep,
    });

    expect(ready).toEqual({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Error",
    });
    // 3 consecutive Error polls trigger the terminal failure; the wait sleeps
    // twice between the first three polls and stops before the full timeout.
    expect(listSandboxes).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("reports the Error phase (not a generic timeout) when the debounce outlasts the timeout", async () => {
    // Small readiness timeout (1 poll) with the default debounce (30): a stuck
    // Error can never reach the debounce threshold, but it must still surface
    // the terminal phase rather than a phase-less timeout (#6043 review PRA-1).
    const { observer, sleep } = replay([terminalSandboxFrame("Error")]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 2, // -> readyAttempts = 1, far below the default 30-poll debounce
      observer,
      target: TARGET,
      sleep,
    });

    expect(ready).toEqual({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Error",
    });
  });

  it.each(["Failed", "CrashLoopBackOff", "ImagePullBackOff", "Evicted", "Unknown"])(
    "fast-fails immediately on genuinely terminal phase %s even with a large debounce",
    async (phase) => {
      const { observer, listSandboxes, sleep } = replay([
        pendingSandboxFrame("Provisioning"),
        terminalSandboxFrame(phase),
      ]);

      const ready = await waitForCreatedSandboxReadyWithTrace({
        sandboxName: NAME,
        timeoutSecs: 600,
        observer,
        target: TARGET,
        // Even with a very large debounce, non-Error terminal phases must not
        // be debounced (#6043 CodeRabbit/advisor: debounce is Error-only).
        errorPhaseDebouncePolls: 999,
        sleep,
      });

      expect(ready).toEqual({
        ready: false,
        reason: "terminal_failure_phase",
        failurePhase: phase,
      });
      expect(listSandboxes).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    },
  );

  it("fast-fails a typed terminal observation without a display phase", async () => {
    const { observer, listSandboxes, sleep } = replay([
      pendingSandboxFrame("Provisioning"),
      terminalSandboxFrame(null),
    ]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      observer,
      target: TARGET,
      errorPhaseDebouncePolls: 999,
      sleep,
    });

    expect(ready).toEqual({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: null,
    });
    expect(listSandboxes).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("rounds a fractional debounce override (2.6 -> 3), matching envInt semantics", async () => {
    const { observer, listSandboxes, sleep } = replay([terminalSandboxFrame("Error")]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      observer,
      target: TARGET,
      errorPhaseDebouncePolls: 2.6,
      sleep,
    });

    expect(ready).toEqual({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Error",
    });
    // round(2.6) === 3 (truncation would give 2), so the 3rd consecutive Error
    // poll is terminal — the same rounding rule as the
    // NEMOCLAW_SANDBOX_READY_ERROR_DEBOUNCE env path.
    expect(listSandboxes).toHaveBeenCalledTimes(3);
  });

  it("ignores a non-finite debounce override and falls back to the env/default", async () => {
    // NaN is not finite, so the override is dropped and the default (30) is
    // used: a 4-poll transient Error still recovers to Ready.
    const { observer } = replay([
      terminalSandboxFrame("Error"),
      terminalSandboxFrame("Error"),
      terminalSandboxFrame("Error"),
      readySandboxFrame(),
    ]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      observer,
      target: TARGET,
      errorPhaseDebouncePolls: Number.NaN,
      sleep: () => {},
    });

    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
  });
});

describe("getSandboxReadyErrorDebouncePolls env contract", () => {
  it("defaults to 30 when the env var is unset", () => {
    expect(getSandboxReadyErrorDebouncePolls({})).toBe(30);
  });

  it("honors a valid override", () => {
    expect(getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "12" })).toBe(
      12,
    );
  });

  it("falls back to the default for empty or non-numeric values", () => {
    expect(getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "" })).toBe(30);
    expect(getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "abc" })).toBe(
      30,
    );
    expect(
      getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "Infinity" }),
    ).toBe(30);
    expect(getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "NaN" })).toBe(
      30,
    );
  });

  it("clamps to a minimum of 1 poll", () => {
    expect(getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "0" })).toBe(1);
    // envInt rounds 0.4 -> 0, then the clamp lifts it to 1.
    expect(getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "0.4" })).toBe(
      1,
    );
  });

  it("falls back for a negative override instead of clamping it to the minimum", () => {
    // A negative is invalid input, so it reaches the documented default the
    // same way "abc" does above, rather than silently becoming the smallest
    // legal debounce (#7881).
    expect(getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "-5" })).toBe(
      30,
    );
  });

  it("rounds fractional env values (envInt semantics)", () => {
    expect(getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "2.6" })).toBe(
      3,
    );
  });
});

// PRA-5 acceptance: typed replay of the reporter's DGX Spark
// gateway/port-fallback phase sequence through the real readiness waiter. DGX
// Spark hardware is unavailable, so this checked-in replay is the acceptance
// gate: it proves the pre-fix fast-fail regressed on the exact reporter signal
// and that the shipped default recovers.
describe("DGX Spark fresh-onboard readiness replay (#6043)", () => {
  // The CLI-adapter test owns the captured table layout that produced these
  // phases. This action test owns the debounce decision for typed observations.
  const reporterPhaseSequence = [
    pendingSandboxFrame("Provisioning"),
    terminalSandboxFrame("Error"),
    terminalSandboxFrame("Error"),
    terminalSandboxFrame("Error"),
    readySandboxFrame(),
  ] as const;

  it("reports Error when the first Error poll reaches a one-poll debounce", async () => {
    const { observer, sleep } = replay(reporterPhaseSequence);
    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 1500,
      observer,
      target: TARGET,
      errorPhaseDebouncePolls: 1,
      sleep,
    });

    expect(ready.ready).toBe(false);
    expect(formatCreatedSandboxReadinessFailureMessage(NAME, ready, 1500)).toContain(
      "entered Error phase before it became ready (waited up to 1500s)",
    );
  });

  it("retains the terminal phase in managed-bootstrap readiness diagnostics (#9819)", () => {
    expect(
      formatCreatedSandboxReadinessFailureMessage(
        NAME,
        { ready: false, reason: "terminal_failure_phase", failurePhase: "Failed" },
        1500,
      ),
    ).toContain("entered Failed phase before it became ready (waited up to 1500s)");
  });

  it("recovers with the shipped default debounce: onboard continues to Ready", async () => {
    const { observer, sleep } = replay(reporterPhaseSequence);
    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 1500,
      observer,
      target: TARGET,
      sleep,
    });

    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
  });

  // Follow-up: when DGX Spark (or an equivalent ARM64 GPU) CI runner becomes
  // available, replace/augment this replay with a live fresh-onboard E2E on
  // that hardware (tracked on #6043). A real worktree-CLI onboard on a healthy
  // non-DGX host was validated for the happy path, but cannot force the
  // transient Error branch this replay exercises.

  // Retiring the debounce requires a live OpenShell trace without transient Error
  // phases, tracked in #6043 and the source-of-truth block in the implementation.
  // This static replay proves the workaround; it cannot establish an upstream fix.
});
