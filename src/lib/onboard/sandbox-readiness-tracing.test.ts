// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { getSandboxFailurePhase, isSandboxReady } from "../state/gateway";
import {
  formatCreatedSandboxReadinessFailureMessage,
  getSandboxReadyErrorDebouncePolls,
  SANDBOX_READY_ERROR_DEBOUNCE_ENV,
  waitForCreatedSandboxReadyWithTrace,
} from "./sandbox-readiness-tracing";

const NAME = "my-sandbox";

function replay(outputs: readonly string[]) {
  let i = 0;
  const runCaptureOpenshell = vi.fn(() => outputs[Math.min(i++, outputs.length - 1)]);
  const sleep = vi.fn();
  return { runCaptureOpenshell, sleep, polls: () => i };
}

describe("waitForCreatedSandboxReadyWithTrace terminal-phase handling", () => {
  it("fast-fails on the first Error poll when the debounce is opted out (K=1)", () => {
    const { runCaptureOpenshell, sleep } = replay([
      `${NAME}   Provisioning   1s ago`,
      `${NAME}   Error          3s ago`,
    ]);

    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      // 600 / 2 = 300 readyAttempts. With the K=1 (no-debounce) opt-out we bail
      // out after the 2nd poll, preserving the original fast-fail intent.
      timeoutSecs: 600,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      errorPhaseDebouncePolls: 1,
      sleep,
    });

    expect(ready).toEqual({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Error",
    });
    expect(runCaptureOpenshell).toHaveBeenCalledTimes(2);
    // Should not sleep after detecting the terminal phase.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("recovers when a transient Error flips to Ready within the debounce window (#6043)", () => {
    // DGX Spark repro: the gateway re-registers the just-created sandbox and
    // `sandbox list` briefly reports Error before flipping to Ready. The
    // default debounce must tolerate the transient rather than fast-failing.
    const { runCaptureOpenshell, sleep } = replay([
      `${NAME}   Provisioning   1s ago`,
      `${NAME}   Error          3s ago`,
      `${NAME}   Error          5s ago`,
      `${NAME}   Ready          7s ago`,
    ]);

    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      sleep,
    });

    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
    expect(runCaptureOpenshell).toHaveBeenCalledTimes(4);
  });

  it("resets the debounce counter when a non-Error poll interrupts the Error streak", () => {
    // Flapping Error must not accumulate toward the terminal threshold.
    const { runCaptureOpenshell, sleep } = replay([
      `${NAME}   Error          1s ago`,
      `${NAME}   Provisioning   3s ago`,
      `${NAME}   Error          5s ago`,
      `${NAME}   Ready          7s ago`,
    ]);

    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      errorPhaseDebouncePolls: 2,
      sleep,
    });

    // Never two consecutive Error polls, so it never crosses the threshold.
    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
  });

  it("still fails terminally after sustained Error exceeds the debounce window (#6043)", () => {
    const { runCaptureOpenshell, sleep } = replay([`${NAME}   Error   3s ago`]);

    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
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
    expect(runCaptureOpenshell).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("reports the Error phase (not a generic timeout) when the debounce outlasts the timeout", () => {
    // Small readiness timeout (1 poll) with the default debounce (30): a stuck
    // Error can never reach the debounce threshold, but it must still surface
    // the terminal phase rather than a phase-less timeout (#6043 review PRA-1).
    const { runCaptureOpenshell, sleep } = replay([`${NAME}   Error   3s ago`]);

    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 2, // -> readyAttempts = 1, far below the default 30-poll debounce
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      sleep,
    });

    expect(ready).toEqual({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Error",
    });
  });

  it.each([
    "Failed",
    "CrashLoopBackOff",
  ])("fast-fails immediately on genuinely terminal phase %s even with a large debounce", (phase) => {
    const { runCaptureOpenshell, sleep } = replay([
      `${NAME}   Provisioning   1s ago`,
      `${NAME}   ${phase}   3s ago`,
    ]);

    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      // Even with a very large debounce, non-Error terminal phases must not
      // be debounced (#6043 CodeRabbit/advisor: debounce is Error-only).
      errorPhaseDebouncePolls: 999,
      sleep,
    });

    expect(ready).toEqual({ ready: false, reason: "terminal_failure_phase", failurePhase: phase });
    expect(runCaptureOpenshell).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("rounds a fractional debounce override (2.6 -> 3), matching envInt semantics", () => {
    const { runCaptureOpenshell, sleep } = replay([`${NAME}   Error   3s ago`]);

    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
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
    expect(runCaptureOpenshell).toHaveBeenCalledTimes(3);
  });

  it("ignores a non-finite debounce override and falls back to the env/default", () => {
    // NaN is not finite, so the override is dropped and the default (30) is
    // used: a 4-poll transient Error still recovers to Ready.
    const { runCaptureOpenshell } = replay([
      `${NAME}   Error   1s ago`,
      `${NAME}   Error   3s ago`,
      `${NAME}   Error   5s ago`,
      `${NAME}   Ready   7s ago`,
    ]);

    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
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
    expect(getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "-5" })).toBe(1);
    // envInt rounds 0.4 -> 0, then the clamp lifts it to 1.
    expect(getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "0.4" })).toBe(
      1,
    );
  });

  it("rounds fractional env values (envInt semantics)", () => {
    expect(getSandboxReadyErrorDebouncePolls({ [SANDBOX_READY_ERROR_DEBOUNCE_ENV]: "2.6" })).toBe(
      3,
    );
  });
});

// PRA-5 acceptance: deterministic replay of the reporter's DGX Spark
// gateway/port-fallback create sequence through the real readiness waiter. DGX
// Spark hardware is unavailable, so this checked-in replay is the acceptance
// gate: it proves the pre-fix fast-fail regressed on the exact reporter signal
// and that the shipped default recovers.
describe("DGX Spark fresh-onboard readiness replay (#6043)", () => {
  // Rows as `openshell sandbox list` reports them while the gateway supervisor
  // restarts (dashboard port fallback 18789 -> 18794) and re-registers the
  // just-created sandbox before it settles to Ready.
  const reporterSequence = [
    `${NAME}   Provisioning   2s ago`,
    `${NAME}   Error          6s ago`,
    `${NAME}   Error          8s ago`,
    `${NAME}   Error          10s ago`,
    `${NAME}   Ready          14s ago`,
  ] as const;

  it("regressed pre-fix: fast-fail (K=1) surfaces the exact reporter failure line", () => {
    const { runCaptureOpenshell, sleep } = replay(reporterSequence);
    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 1500,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      errorPhaseDebouncePolls: 1,
      sleep,
    });

    expect(ready.ready).toBe(false);
    expect(formatCreatedSandboxReadinessFailureMessage(NAME, ready, 1500)).toContain(
      "entered Error phase before it became ready (waited up to 1500s)",
    );
  });

  it("recovers with the shipped default debounce: onboard continues to Ready", () => {
    const { runCaptureOpenshell, sleep } = replay(reporterSequence);
    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 1500,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      sleep,
    });

    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
  });

  // Follow-up: when DGX Spark (or an equivalent ARM64 GPU) CI runner becomes
  // available, replace/augment this replay with a live fresh-onboard E2E on
  // that hardware (tracked on #6043). A real worktree-CLI onboard on a healthy
  // non-DGX host was validated for the happy path, but cannot force the
  // transient Error branch this replay exercises.

  // Removal signal for the debounce workaround (see the source-of-truth block
  // in sandbox-readiness-tracing.ts). Removal is tracked on NemoClaw #6043
  // (https://github.com/NVIDIA/NemoClaw/issues/6043), which owns the pending
  // upstream OpenShell `sandbox list` fix. A maintainer
  // enables this once OpenShell guarantees `sandbox list` no longer reports a
  // transient Error while the gateway re-registers a just-created sandbox: if
  // the raw upstream sequence contains no Error rows, the debounce in
  // waitForCreatedSandboxReadyWithTrace can be deleted.
  it.skip("upstream_openshell_sandbox_list_error_transient_fixed", () => {
    // Replace `reporterSequence` with a captured `sandbox list` trace from a
    // fixed OpenShell during a fresh GPU onboard, then assert no Error rows.
    const hasTransientError = reporterSequence.some(
      (row) => getSandboxFailurePhase(row, NAME) === "Error",
    );
    expect(hasTransientError).toBe(false);
  });
});
