// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { envInt } from "./env";
import { addTraceEvent, withDashboardReadinessTrace, withSandboxReadinessTrace } from "./tracing";

type RunCaptureOpenshell = (args: string[], options?: { ignoreError?: boolean }) => string;

export const SANDBOX_READY_ERROR_DEBOUNCE_ENV = "NEMOCLAW_SANDBOX_READY_ERROR_DEBOUNCE";

/*
 * Create/readiness Error-phase debounce.
 *
 * Invalid state
 * -------------
 * On a fresh onboard the OpenShell gateway may (re)start its supervisor
 * session and re-register the just-created sandbox. During that window
 * `openshell sandbox list` briefly reports the sandbox in the transient
 * "Error" phase before it flips to Ready. Observed on DGX Spark, where the
 * dashboard port fallback (18789 -> 18794) and supervisor restart race the
 * sandbox bootstrap (#6043). Fast-failing on the first Error poll turns that
 * recoverable transient into a terminal onboard failure.
 *
 * Source-of-truth boundary
 * ------------------------
 * The transient lives in the OpenShell gateway's `sandbox list` cache: the
 * preferred fix is upstream — `sandbox list` should not report a terminal
 * phase for a sandbox the gateway is still registering. Until that ships,
 * NemoClaw tolerates the transient at this layer via a consecutive-Error-poll
 * debounce, mirroring the Docker GPU supervisor-reconnect path
 * (docker-gpu-supervisor-reconnect.ts), which tolerates the same class of
 * transient while a recreated GPU container reconnects.
 *
 * Scope
 * -----
 * Only the "Error" phase is debounced. "Failed" and "CrashLoopBackOff" are
 * genuinely terminal and still fast-fail immediately. A sandbox that stays in
 * Error also fast-fails after the bounded debounce window (well before the
 * full readiness timeout), and the caller still captures full failure
 * diagnostics — this does NOT hide terminal failures.
 *
 * Regression evidence / removal condition
 * ---------------------------------------
 * Delete this debounce once OpenShell guarantees `sandbox list` skips the
 * brief Error transition during a known registration. The runtime evidence
 * required is a fresh-onboard reproduction (DGX Spark, or the deterministic
 * `sandbox list` replay in sandbox-readiness-tracing.test.ts) showing a
 * transient create-time Error that recovers to Ready.
 *
 * Tracking mechanism: removal is tracked on NemoClaw #6043
 * (https://github.com/NVIDIA/NemoClaw/issues/6043), which owns the pending
 * OpenShell `sandbox list` fix. The maintainer-enabled removal-signal
 * test `upstream_openshell_sandbox_list_error_transient_fixed`
 * (sandbox-readiness-tracing.test.ts, currently `it.skip`) is the executable
 * checkpoint — point it at a captured `sandbox list` trace from a fixed
 * OpenShell and, once it passes (no transient Error), this debounce can be
 * removed. Escalate to a dedicated OpenShell-fix tracking issue (referenced
 * here and in the test) if the workaround outlives a release cycle.
 *
 * The readiness loop polls `sandbox list` every 2 seconds, so the default of
 * 30 tolerates ~60s of sustained Error before failing.
 */
const SANDBOX_READY_ERROR_PHASE_DEFAULT_DEBOUNCE_POLLS = 30;

export function getSandboxReadyErrorDebouncePolls(
  env: Record<string, string | undefined> = process.env,
): number {
  return Math.max(
    1,
    envInt(SANDBOX_READY_ERROR_DEBOUNCE_ENV, SANDBOX_READY_ERROR_PHASE_DEFAULT_DEBOUNCE_POLLS, env),
  );
}

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
  /**
   * Consecutive Error-phase polls required before the wait treats the phase as
   * terminal. Defaults to {@link getSandboxReadyErrorDebouncePolls} (30 polls /
   * ~60s at the 2s poll interval).
   *
   * Trade-off: on a fresh create — the path this waiter guards — a healthy
   * sandbox that briefly transits Error costs nothing (it flips to Ready and
   * the wait returns on that poll), while a genuinely stuck Error is reported
   * ~60s later than a fast-fail would. The default is deliberately conservative
   * rather than tuned to the shortest observed transient: the re-registration
   * window scales with host/gateway speed (slower on ARM64/DGX-class hosts), so
   * a too-low default risks re-introducing #6043. The window is bounded and far
   * below the readiness timeout, so it never masks a terminal failure; operators
   * who want a tighter bound set NEMOCLAW_SANDBOX_READY_ERROR_DEBOUNCE.
   *
   * Fractional values are rounded (Math.round), matching the env-var path's
   * envInt rounding for one consistent rule across both entry points. Pass 1 to
   * restore the original fast-fail-on-first-Error behavior (used by callers
   * that have already ruled out the transient supervisor-reconnect race).
   */
  errorPhaseDebouncePolls?: number;
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
  const errorPhaseDebouncePolls =
    options.errorPhaseDebouncePolls == null || !Number.isFinite(options.errorPhaseDebouncePolls)
      ? getSandboxReadyErrorDebouncePolls()
      : // Round (not truncate) so a fractional override matches the env-var
        // path's envInt rounding — one consistent rule for both entry points.
        Math.max(1, Math.round(options.errorPhaseDebouncePolls));
  return withSandboxReadinessTrace(sandboxName, { timeout_seconds: timeoutSecs }, () => {
    const readyAttempts = Math.max(1, Math.ceil(timeoutSecs / 2));
    let consecutiveFailurePolls = 0;
    let lastFailurePhase: string | null = null;
    for (let i = 0; i < readyAttempts; i++) {
      const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (isSandboxReady(list, sandboxName)) {
        addTraceEvent("ready", { attempt: i + 1 });
        return { ready: true, reason: "ready", failurePhase: null };
      }
      const failurePhase = getSandboxFailurePhase?.(list, sandboxName) ?? null;
      // Only the transient "Error" phase is debounced — it is the phase the
      // gateway briefly reports while re-registering the just-created sandbox
      // (#6043). "Failed" and "CrashLoopBackOff" are genuinely terminal and
      // must still fast-fail immediately rather than burn the debounce window.
      if (failurePhase && failurePhase !== "Error") {
        addTraceEvent("terminal_failure_phase", { attempt: i + 1, failure_phase: failurePhase });
        return { ready: false, reason: "terminal_failure_phase", failurePhase };
      }
      if (failurePhase === "Error") {
        consecutiveFailurePolls += 1;
        lastFailurePhase = failurePhase;
        // Sustained Error is terminal; a transient Error while the gateway
        // re-registers the sandbox recovers on a later poll (#6043).
        if (consecutiveFailurePolls >= errorPhaseDebouncePolls) {
          addTraceEvent("terminal_failure_phase", {
            attempt: i + 1,
            failure_phase: failurePhase,
            consecutive_polls: consecutiveFailurePolls,
          });
          return { ready: false, reason: "terminal_failure_phase", failurePhase };
        }
        addTraceEvent("transient_failure_phase", {
          attempt: i + 1,
          failure_phase: failurePhase,
          consecutive_polls: consecutiveFailurePolls,
          debounce_polls: errorPhaseDebouncePolls,
        });
      } else {
        consecutiveFailurePolls = 0;
      }
      if (i < readyAttempts - 1) sleep(2);
    }
    // If the sandbox is still in Error on the final poll, surface the terminal
    // phase instead of a generic timeout. This happens when the configured
    // debounce window is larger than the readiness timeout allows (e.g. a low
    // NEMOCLAW_SANDBOX_READY_TIMEOUT with the default 30-poll debounce), so a
    // genuinely stuck Error would otherwise be misreported as "did not become
    // ready" and drop the phase (#6043 review).
    if (consecutiveFailurePolls > 0 && lastFailurePhase) {
      addTraceEvent("terminal_failure_phase", {
        attempts: readyAttempts,
        failure_phase: lastFailurePhase,
        consecutive_polls: consecutiveFailurePolls,
        debounce_polls: errorPhaseDebouncePolls,
        note: "debounce_window_exceeded_timeout",
      });
      return { ready: false, reason: "terminal_failure_phase", failurePhase: lastFailurePhase };
    }
    addTraceEvent("not_ready", { attempts: readyAttempts, last_failure_phase: lastFailurePhase });
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
