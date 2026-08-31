// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { waitUntil } from "../core/wait";
import { envInt } from "./env";
import {
  createReadinessWaitOptions,
  formatReadinessDeadline,
  getLegacyPollDeadlineBudgetMs,
} from "./readiness-wait";
import { addTraceEvent, withDashboardReadinessTrace, withSandboxReadinessTrace } from "./tracing";

type RunCaptureOpenshell = (args: string[], options?: { ignoreError?: boolean }) => string;

export const SANDBOX_READY_ERROR_DEBOUNCE_ENV = "NEMOCLAW_SANDBOX_READY_ERROR_DEBOUNCE";

/*
 * OpenShell can briefly report Error while it registers a new sandbox.
 * Debounce only Error; Failed and CrashLoopBackOff remain terminal. Remove
 * this workaround only after a fresh-onboard trace from fixed OpenShell
 * contains no transient Error phase. The skipped removal-signal test in
 * sandbox-readiness-tracing.test.ts records that checkpoint (#6043).
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
  | { ready: false; reason: "identity_changed"; failurePhase: null }
  | { ready: false; reason: "identity_probe_failed"; failurePhase: null }
  | { ready: false; reason: "timeout"; failurePhase: null };

export type CreatedSandboxReadyIdentityCheck = (
  getRemainingMs?: () => number,
) => "ready" | "not_ready" | "identity_changed" | "probe_failed";

export interface SandboxReadyWaitDeps {
  runCaptureOpenshell: RunCaptureOpenshell;
  isSandboxReady: (output: string, sandboxName: string) => boolean;
  isLinuxDockerDriverGatewayEnabled: () => boolean;
  sleep: (seconds: number) => void;
  now?: () => number;
}

export interface SandboxReadyWaitOptions extends SandboxReadyWaitDeps {
  sandboxName: string;
  attempts: number;
  delaySeconds: number;
}

/** Wait for one owner-scoped created-sandbox publication within a fixed deadline. */
export function waitForCreatedSandboxPublication(options: {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly probe: (getRemainingMs: () => number) => boolean;
  readonly sleep: (seconds: number) => void;
  readonly now?: () => number;
}): boolean {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(1, Math.round(options.timeoutMs));
  const pollIntervalMs = Math.max(0, options.pollIntervalMs);
  const deadlineMs = now() + timeoutMs;
  return waitUntil(() => options.probe(() => Math.max(1, deadlineMs - now())), {
    deadlineMs,
    initialIntervalMs: pollIntervalMs,
    maxIntervalMs: pollIntervalMs,
    maxAttempts: Math.ceil(timeoutMs / Math.max(1, pollIntervalMs)) + 1,
    now,
    sleep: (ms) => options.sleep(ms / 1_000),
  });
}

function pollSandboxReady(
  options: SandboxReadyWaitOptions & {
    trace?: (event: string, attributes: Record<string, unknown>) => void;
  },
): boolean {
  const {
    sandboxName,
    attempts,
    delaySeconds,
    runCaptureOpenshell,
    isSandboxReady,
    isLinuxDockerDriverGatewayEnabled,
    sleep,
  } = options;
  let attempt = 0;
  const budgetMs = getLegacyPollDeadlineBudgetMs(attempts, delaySeconds);
  const waitOptions = createReadinessWaitOptions({
    budgetMs,
    maxIntervalMs: Math.max(0, delaySeconds * 1000),
    zeroBudgetAttempts: attempts,
    now: options.now,
    sleep: (ms) => sleep(ms / 1000),
  });
  if (!waitOptions) {
    options.trace?.("not_ready", { attempts: 0, deadline_ms: budgetMs });
    return false;
  }
  const ready = waitUntil(() => {
    attempt += 1;
    const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
    if (isSandboxReady(list, sandboxName)) {
      options.trace?.("ready", { attempt, source: "sandbox_list" });
      return true;
    }

    // Package-managed OpenShell gateways report readiness through
    // `sandbox list`; legacy Kubernetes gateways may still expose pod state.
    if (isLinuxDockerDriverGatewayEnabled()) {
      return false;
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
      options.trace?.("ready", { attempt, source: "pod_phase" });
      return true;
    }
    return false;
  }, waitOptions);
  if (!ready) options.trace?.("not_ready", { attempts: attempt, deadline_ms: budgetMs });
  return ready;
}

export function waitForSandboxReadyWithTrace(options: SandboxReadyWaitOptions): boolean {
  return withSandboxReadinessTrace(
    options.sandboxName,
    { attempts: options.attempts, delay_seconds: options.delaySeconds },
    () => pollSandboxReady({ ...options, trace: addTraceEvent }),
  );
}

export function createSandboxReadyWaiter(
  deps: SandboxReadyWaitDeps,
): (sandboxName: string, attempts?: number, delaySeconds?: number) => boolean {
  return (sandboxName, attempts = 10, delaySeconds = 2) =>
    pollSandboxReady({
      sandboxName,
      attempts,
      delaySeconds,
      ...deps,
    });
}

export function waitForCreatedSandboxReadyWithTrace(options: {
  sandboxName: string;
  gatewayName: string;
  timeoutSecs: number;
  runCaptureOpenshell: RunCaptureOpenshell;
  isSandboxReady: (output: string, sandboxName: string) => boolean;
  /**
   * Optional terminal-failure-phase classifier. Failed and CrashLoopBackOff
   * stop the wait immediately. Error stops it after the configured number of
   * consecutive Error observations (#4316).
   */
  getSandboxFailurePhase?: (output: string, sandboxName: string) => string | null;
  /**
   * Consecutive Ready polls required before returning success. Defaults to 1.
   * The Docker GPU compatibility recreate passes 2 because the OpenShell
   * gateway can briefly retain the pre-recreate Ready row before publishing
   * the new supervisor's Error -> Ready registration transition. Requiring a
   * confirmation poll at the original two-second interval keeps that stale row
   * from reaching the GPU proof.
   */
  stableReadyPolls?: number;
  /**
   * Optional durable-identity and executability proof after OpenShell first
   * reports Ready. A transient not-ready result stays inside this bounded
   * wait. Recreated sandboxes also compare the durable identity with the
   * pre-recreate value. Identity changes and all other probe failures remain
   * terminal.
   */
  checkReadyIdentity?: CreatedSandboxReadyIdentityCheck;
  /**
   * Consecutive Error-phase polls required before the wait treats the phase as
   * terminal. Defaults to {@link getSandboxReadyErrorDebouncePolls} (30 polls).
   *
   * Trade-off: on a fresh create — the path this waiter guards — a healthy
   * sandbox that briefly transits Error costs nothing (it flips to Ready and
   * the wait returns on that poll), while a genuinely stuck Error is reported
   * after the configured number of observations. The default is deliberately
   * conservative rather than tuned to the shortest observed transient: the
   * re-registration window scales with host/gateway speed (slower on
   * ARM64/DGX-class hosts), so a too-low default risks re-introducing #6043.
   * The readiness deadline still bounds the wait; operators who want fewer
   * observations set NEMOCLAW_SANDBOX_READY_ERROR_DEBOUNCE.
   *
   * Fractional values are rounded (Math.round), matching the env-var path's
   * envInt rounding for one consistent rule across both entry points. Pass 1 to
   * restore the original fast-fail-on-first-Error behavior (used by callers
   * that have already ruled out the transient supervisor-reconnect race).
   */
  errorPhaseDebouncePolls?: number;
  sleep: (seconds: number) => void;
  now?: () => number;
}): CreatedSandboxReadinessResult {
  const {
    sandboxName,
    gatewayName,
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
  const stableReadyPolls =
    options.stableReadyPolls == null || !Number.isFinite(options.stableReadyPolls)
      ? 1
      : Math.max(1, Math.round(options.stableReadyPolls));
  return withSandboxReadinessTrace(sandboxName, { timeout_seconds: timeoutSecs }, () => {
    const budgetMs = Math.max(0, timeoutSecs * 1000);
    const waitOptions = createReadinessWaitOptions({
      budgetMs,
      initialIntervalMs: stableReadyPolls > 1 ? 2_000 : undefined,
      maxIntervalMs: 2_000,
      now: options.now,
      sleep: (ms) => sleep(ms / 1000),
    });
    if (!waitOptions) {
      addTraceEvent("not_ready", { attempts: 0, deadline_ms: budgetMs });
      return { ready: false, reason: "timeout", failurePhase: null };
    }
    const readinessDeadlineMs = waitOptions.deadlineMs;
    const readinessNow = waitOptions.now;
    if (readinessDeadlineMs === undefined || readinessNow === undefined) {
      throw new Error("Created sandbox readiness requires a deadline and clock.");
    }
    const getRemainingMs = () => Math.max(0, readinessDeadlineMs - readinessNow());
    let consecutiveReadyPolls = 0;
    let consecutiveFailurePolls = 0;
    let lastFailurePhase: string | null = null;
    let attempt = 0;
    let result: CreatedSandboxReadinessResult | null = null;
    waitUntil(() => {
      attempt += 1;
      const list = runCaptureOpenshell(["sandbox", "list", "-g", gatewayName], {
        ignoreError: true,
      });
      if (isSandboxReady(list, sandboxName)) {
        const identity = options.checkReadyIdentity?.(getRemainingMs) ?? "ready";
        if (identity === "identity_changed") {
          addTraceEvent("identity_changed", { attempt });
          result = {
            ready: false,
            reason: "identity_changed",
            failurePhase: null,
          };
          return true;
        }
        if (identity === "probe_failed") {
          addTraceEvent("identity_probe_failed", { attempt });
          result = {
            ready: false,
            reason: "identity_probe_failed",
            failurePhase: null,
          };
          return true;
        }
        if (identity === "not_ready") {
          consecutiveReadyPolls = 0;
          consecutiveFailurePolls = 0;
          lastFailurePhase = null;
          addTraceEvent("ready_identity_pending", { attempt });
          return false;
        }
        consecutiveReadyPolls += 1;
        consecutiveFailurePolls = 0;
        lastFailurePhase = null;
        if (consecutiveReadyPolls >= stableReadyPolls) {
          addTraceEvent("ready", {
            attempt,
            consecutive_polls: consecutiveReadyPolls,
          });
          result = { ready: true, reason: "ready", failurePhase: null };
          return true;
        }
        addTraceEvent("ready_pending_stability", {
          attempt,
          consecutive_polls: consecutiveReadyPolls,
          required_polls: stableReadyPolls,
        });
        return false;
      }
      consecutiveReadyPolls = 0;
      const failurePhase = getSandboxFailurePhase?.(list, sandboxName) ?? null;
      // Only the transient "Error" phase is debounced — it is the phase the
      // gateway briefly reports while re-registering the just-created sandbox
      // (#6043). "Failed" and "CrashLoopBackOff" are genuinely terminal and
      // must still fast-fail immediately rather than burn the debounce window.
      if (failurePhase && failurePhase !== "Error") {
        addTraceEvent("terminal_failure_phase", { attempt, failure_phase: failurePhase });
        result = { ready: false, reason: "terminal_failure_phase", failurePhase };
        return true;
      }
      if (failurePhase === "Error") {
        consecutiveFailurePolls += 1;
        lastFailurePhase = failurePhase;
        // Sustained Error is terminal; a transient Error while the gateway
        // re-registers the sandbox recovers on a later poll (#6043).
        if (consecutiveFailurePolls >= errorPhaseDebouncePolls) {
          addTraceEvent("terminal_failure_phase", {
            attempt,
            failure_phase: failurePhase,
            consecutive_polls: consecutiveFailurePolls,
          });
          result = { ready: false, reason: "terminal_failure_phase", failurePhase };
          return true;
        }
        addTraceEvent("transient_failure_phase", {
          attempt,
          failure_phase: failurePhase,
          consecutive_polls: consecutiveFailurePolls,
          debounce_polls: errorPhaseDebouncePolls,
        });
      } else {
        consecutiveFailurePolls = 0;
      }
      return false;
    }, waitOptions);
    if (result) return result;
    // If the sandbox is still in Error on the final poll, surface the terminal
    // phase instead of a generic timeout. This happens when the configured
    // debounce window is larger than the readiness timeout allows (e.g. a low
    // NEMOCLAW_SANDBOX_READY_TIMEOUT with the default 30-poll debounce), so a
    // genuinely stuck Error would otherwise be misreported as "did not become
    // ready" and drop the phase (#6043 review).
    if (consecutiveFailurePolls > 0 && lastFailurePhase) {
      addTraceEvent("terminal_failure_phase", {
        attempts: attempt,
        failure_phase: lastFailurePhase,
        consecutive_polls: consecutiveFailurePolls,
        debounce_polls: errorPhaseDebouncePolls,
        note: "debounce_window_exceeded_timeout",
      });
      return { ready: false, reason: "terminal_failure_phase", failurePhase: lastFailurePhase };
    }
    addTraceEvent("not_ready", {
      attempts: attempt,
      deadline_ms: budgetMs,
      last_failure_phase: lastFailurePhase,
    });
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
  if (readiness.reason === "identity_changed") {
    return `  Sandbox '${sandboxName}' changed identity before its recreated runtime became ready.`;
  }
  if (readiness.reason === "identity_probe_failed") {
    return `  NemoClaw could not verify that sandbox '${sandboxName}' returned a durable ID and accepted commands.`;
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
  timeoutSecs?: number;
  now?: () => number;
  trace?: typeof addTraceEvent;
}): boolean {
  const { sandboxName, port, runCaptureOpenshell, sleep } = options;
  const timeoutSecs = options.timeoutSecs ?? 30;
  const budgetMs = Math.max(0, timeoutSecs * 1000);
  return withDashboardReadinessTrace(sandboxName, port, timeoutSecs, () => {
    let attempt = 0;
    const waitOptions = createReadinessWaitOptions({
      budgetMs,
      maxIntervalMs: 2_000,
      now: options.now,
      sleep: (ms) => sleep(ms / 1000),
    });
    const traceEvent = options.trace ?? addTraceEvent;
    if (!waitOptions) {
      traceEvent("not_ready", { attempts: 0, deadline_ms: budgetMs });
    }
    const ready =
      waitOptions !== null &&
      waitUntil(() => {
        attempt += 1;
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
        traceEvent("dashboard_probe", { attempt, http_status: readyCode });
        return readyCode === 200 || readyCode === 401;
      }, waitOptions);
    if (ready) {
      console.log("  ✓ Dashboard is live");
      return true;
    }
    console.warn(
      `  Dashboard did not become ready within the configured ${formatReadinessDeadline(budgetMs)} deadline. Continuing...`,
    );
    return false;
  });
}
