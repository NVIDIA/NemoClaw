// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { addTraceEvent, withDashboardReadinessTrace, withSandboxReadinessTrace } from "./tracing";

type RunCaptureOpenshell = (args: string[], options?: { ignoreError?: boolean }) => string;

export type CreatedSandboxReadinessResult =
  | { ready: true; reason: "ready"; failurePhase: null }
  | { ready: false; reason: "terminal_failure_phase"; failurePhase: string | null }
  | { ready: false; reason: "timeout"; failurePhase: null };

export function waitForSandboxReadyWithTrace(options: {
  sandboxName: string;
  attempts: number;
  delaySeconds: number;
  runCaptureOpenshell: RunCaptureOpenshell;
  isSandboxReady: (output: string, sandboxName: string) => boolean;
  isLinuxDockerDriverGatewayEnabled: () => boolean;
  sleep: (seconds: number) => void;
}): boolean {
  const {
    sandboxName,
    attempts,
    delaySeconds,
    runCaptureOpenshell,
    isSandboxReady,
    isLinuxDockerDriverGatewayEnabled,
    sleep,
  } = options;
  return withSandboxReadinessTrace(sandboxName, { attempts, delay_seconds: delaySeconds }, () => {
    for (let i = 0; i < attempts; i += 1) {
      const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (isSandboxReady(list, sandboxName)) {
        addTraceEvent("ready", { attempt: i + 1, source: "sandbox_list" });
        return true;
      }

      // Package-managed OpenShell gateways report readiness through
      // `sandbox list`; legacy Kubernetes gateways may still expose pod state.
      if (isLinuxDockerDriverGatewayEnabled()) {
        if (i < attempts - 1) sleep(delaySeconds);
        continue;
      }
      const podPhase = runCaptureOpenshell(
        [
          "doctor",
          "exec",
          "--",
          "kubectl",
          "-n",
          "openshell",
          "get",
          "pod",
          sandboxName,
          "-o",
          "jsonpath={.status.phase}",
        ],
        { ignoreError: true },
      );
      if (podPhase === "Running") {
        addTraceEvent("ready", { attempt: i + 1, source: "pod_phase" });
        return true;
      }
      if (i < attempts - 1) sleep(delaySeconds);
    }
    addTraceEvent("not_ready", { attempts });
    return false;
  });
}

export function waitForCreatedSandboxReadyWithTrace(options: {
  sandboxName: string;
  timeoutSecs: number;
  runCaptureOpenshell: RunCaptureOpenshell;
  isSandboxReady: (output: string, sandboxName: string) => boolean;
  /**
   * Optional terminal-failure-phase classifier. When provided, the waiter
   * short-circuits as soon as the sandbox enters a terminal failure phase
   * (e.g. Error / Failed / CrashLoopBackOff) rather than burning the full
   * timeout window before reporting "did not become ready" (#4316).
   */
  getSandboxFailurePhase?: (output: string, sandboxName: string) => string | null;
  sleep: (seconds: number) => void;
}): CreatedSandboxReadinessResult {
  const {
    sandboxName,
    timeoutSecs,
    runCaptureOpenshell,
    isSandboxReady,
    getSandboxFailurePhase,
    sleep,
  } = options;
  return withSandboxReadinessTrace(sandboxName, { timeout_seconds: timeoutSecs }, () => {
    const readyAttempts = Math.max(1, Math.ceil(timeoutSecs / 2));
    for (let i = 0; i < readyAttempts; i++) {
      const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (isSandboxReady(list, sandboxName)) {
        addTraceEvent("ready", { attempt: i + 1 });
        return { ready: true, reason: "ready", failurePhase: null };
      }
      const failurePhase = getSandboxFailurePhase?.(list, sandboxName) ?? null;
      if (failurePhase) {
        addTraceEvent("terminal_failure_phase", { attempt: i + 1, failure_phase: failurePhase });
        return { ready: false, reason: "terminal_failure_phase", failurePhase };
      }
      if (i < readyAttempts - 1) sleep(2);
    }
    addTraceEvent("not_ready", { attempts: readyAttempts });
    return { ready: false, reason: "timeout", failurePhase: null };
  });
}

/**
 * Format the user-facing readiness failure message based on whether the
 * waiter short-circuited on a terminal sandbox phase or actually timed out.
 * Keeps the message branching close to the readiness contract so callers
 * (notably onboard.ts) stay thin (#4316 codebase-growth guardrail).
 */
export function formatCreatedSandboxReadinessFailureMessage(
  sandboxName: string,
  readiness: CreatedSandboxReadinessResult,
  timeoutSecs: number,
): string {
  if (readiness.reason === "terminal_failure_phase") {
    const phase = readiness.failurePhase ?? "a terminal failure";
    return `  Sandbox '${sandboxName}' entered ${phase} phase before it became ready (waited up to ${timeoutSecs}s).`;
  }
  return `  Sandbox '${sandboxName}' was created but did not become ready within ${timeoutSecs}s.`;
}

export function printReadinessFailure(
  readiness: CreatedSandboxReadinessResult,
  sandboxName: string,
  timeoutSecs: number,
  logError: (message: string) => void = (message) => console.error(message),
): void {
  logError(formatCreatedSandboxReadinessFailureMessage(sandboxName, readiness, timeoutSecs));
}

export function waitForDashboardReadyWithTrace(options: {
  sandboxName: string;
  port: string | number;
  runCaptureOpenshell: RunCaptureOpenshell;
  sleep: (seconds: number) => void;
}): void {
  const { sandboxName, port, runCaptureOpenshell, sleep } = options;
  withDashboardReadinessTrace(sandboxName, port, 15, () => {
    for (let i = 0; i < 15; i++) {
      const readyOutput = runCaptureOpenshell(
        [
          "sandbox",
          "exec",
          "-n",
          sandboxName,
          "--",
          "curl",
          "-so",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--max-time",
          "3",
          `http://localhost:${port}/health`,
        ],
        { ignoreError: true },
      );
      const readyCode = parseInt((readyOutput || "").trim(), 10) || 0;
      addTraceEvent("dashboard_probe", { attempt: i + 1, http_status: readyCode });
      if (readyCode === 200 || readyCode === 401) {
        console.log("  ✓ Dashboard is live");
        return;
      }
      if (i === 14) {
        console.warn("  Dashboard taking longer than expected to start. Continuing...");
      } else {
        sleep(2);
      }
    }
  });
}
