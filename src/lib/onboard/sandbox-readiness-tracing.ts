// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellGatewayTarget,
  OpenShellSandboxError,
  OpenShellSandboxLookup,
  OpenShellSandboxObserver,
  OpenShellSandboxReadinessProbe,
  OpenShellSandboxResult,
} from "../adapters/openshell/sandbox-observer";
import { namedOpenShellGateway } from "../adapters/openshell/sandbox-observer";
import {
  createCliOpenShellLegacyPodReadinessProbe,
  createCliOpenShellSandboxObserver,
  type CliOpenShellSandboxObserverDeps,
} from "../adapters/openshell/sandbox-observer-cli";
import { waitUntil, waitUntilAsync } from "../core/wait";
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
 * Only the "Error" phase is debounced. Other terminal phases still fast-fail
 * immediately. A sandbox that stays in Error becomes terminal after the
 * bounded debounce window. If the readiness deadline expires first, NemoClaw
 * reports the Error phase. The caller still captures full failure diagnostics,
 * so this does not hide terminal failures.
 *
 * Regression evidence / removal condition
 * ---------------------------------------
 * Delete this debounce once OpenShell guarantees `sandbox list` skips the
 * brief Error transition during a known registration. The runtime evidence
 * required is a fresh-onboard trace from a fixed OpenShell release that reaches
 * Ready without reporting a transient create-time Error. The CLI-adapter test
 * owns the captured table layout, and sandbox-readiness-tracing.test.ts owns
 * the typed phase replay.
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
 * The readiness loop starts at 250ms and backs off to 2 seconds. The default
 * of 30 therefore tolerates a substantial transient window while the overall
 * sandbox readiness deadline remains authoritative.
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
  | {
      ready: false;
      reason: "observation_failed";
      failurePhase: null;
      error: OpenShellSandboxError;
    }
  | { ready: false; reason: "timeout"; failurePhase: null };

export type SandboxReadyWaitResult =
  | { ready: true; reason: "ready"; error: null }
  | { ready: false; reason: "observation_failed"; error: OpenShellSandboxError }
  | { ready: false; reason: "timeout"; error: null };

export type CreatedSandboxReadyIdentityCheck = (
  getRemainingMs?: () => number,
) => "ready" | "not_ready" | "identity_changed" | "probe_failed";

export interface SandboxReadyWaitDeps {
  observer: OpenShellSandboxObserver;
  target: OpenShellGatewayTarget;
  fallbackReadinessProbe?: OpenShellSandboxReadinessProbe;
  isLinuxDockerDriverGatewayEnabled: () => boolean;
  sleep: (seconds: number) => void;
  now?: () => number;
}

export interface SandboxReadyWaitOptions extends SandboxReadyWaitDeps {
  sandboxName: string;
  attempts: number;
  delaySeconds: number;
}

export async function observeOpenShellSandbox(
  observer: OpenShellSandboxObserver,
  target: OpenShellGatewayTarget,
  sandboxName: string,
  timeoutMs?: number,
): Promise<OpenShellSandboxResult<OpenShellSandboxLookup>> {
  const result = await observer.listSandboxes({
    target,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (!result.ok) return result;
  const sandbox = result.value.sandboxes.find((candidate) => candidate.name === sandboxName);
  return sandbox
    ? { ok: true, value: { state: "present", sandbox } }
    : { ok: true, value: { state: "missing" } };
}

function isTransientObservationError(error: OpenShellSandboxError): boolean {
  return error.kind === "timeout" || (error.kind === "transport" && error.reason === "unreachable");
}

function remainingObservationTimeoutMs(deadlineMs?: number, now?: () => number): number {
  if (deadlineMs === undefined || now === undefined) return 1;
  return Math.max(1, Math.floor(deadlineMs - now()));
}

async function settleSandboxObservation<T>(
  observe: () => Promise<OpenShellSandboxResult<T>>,
): Promise<OpenShellSandboxResult<T>> {
  try {
    return await observe();
  } catch {
    return {
      ok: false,
      error: {
        kind: "command",
        reason: "failed",
        message: "OpenShell sandbox observation failed before returning a result.",
      },
    };
  }
}

async function pollSandboxReady(
  options: SandboxReadyWaitOptions & {
    trace?: (event: string, attributes: Record<string, unknown>) => void;
  },
): Promise<SandboxReadyWaitResult> {
  const {
    sandboxName,
    attempts,
    delaySeconds,
    observer,
    target,
    fallbackReadinessProbe,
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
    return { ready: false, reason: "timeout", error: null };
  }
  let result: SandboxReadyWaitResult | null = null;
  const transient = { error: null as OpenShellSandboxError | null };
  await waitUntilAsync(async () => {
    attempt += 1;
    const observation = await settleSandboxObservation(() =>
      observeOpenShellSandbox(
        observer,
        target,
        sandboxName,
        remainingObservationTimeoutMs(waitOptions.deadlineMs, waitOptions.now),
      ),
    );
    if (!observation.ok) {
      if (isTransientObservationError(observation.error)) {
        transient.error = observation.error;
        options.trace?.("observation_retry", {
          attempt,
          error_kind: observation.error.kind,
          error_reason: "reason" in observation.error ? observation.error.reason : null,
        });
        return false;
      }
      result = { ready: false, reason: "observation_failed", error: observation.error };
      options.trace?.("observation_failed", {
        attempt,
        error_kind: observation.error.kind,
        error_reason: "reason" in observation.error ? observation.error.reason : null,
      });
      return true;
    }
    transient.error = null;
    if (observation.value.state === "present" && observation.value.sandbox.readiness === "ready") {
      options.trace?.("ready", { attempt, source: "sandbox_list" });
      result = { ready: true, reason: "ready", error: null };
      return true;
    }

    // Compatibility boundary: new readiness behavior must use `sandbox list`.
    // Only existing non-Docker legacy gateways may fall back to Kubernetes pod
    // phase. #9811 removes this probe after every supported gateway reports
    // readiness through `sandbox list`.
    if (isLinuxDockerDriverGatewayEnabled()) {
      return false;
    }
    const fallback = fallbackReadinessProbe
      ? await settleSandboxObservation(() =>
          fallbackReadinessProbe({
            target,
            sandboxName,
            timeoutMs: remainingObservationTimeoutMs(waitOptions.deadlineMs, waitOptions.now),
          }),
        )
      : undefined;
    if (fallback && !fallback.ok) {
      if (isTransientObservationError(fallback.error)) {
        transient.error = fallback.error;
        options.trace?.("observation_retry", {
          attempt,
          error_kind: fallback.error.kind,
          error_reason: "reason" in fallback.error ? fallback.error.reason : null,
        });
        return false;
      }
      result = { ready: false, reason: "observation_failed", error: fallback.error };
      options.trace?.("observation_failed", {
        attempt,
        error_kind: fallback.error.kind,
        error_reason: "reason" in fallback.error ? fallback.error.reason : null,
      });
      return true;
    }
    if (fallback?.ok && fallback.value === "ready") {
      options.trace?.("ready", { attempt, source: "pod_phase" });
      result = { ready: true, reason: "ready", error: null };
      return true;
    }
    return false;
  }, waitOptions);
  if (result) return result;
  if (transient.error) {
    options.trace?.("observation_failed", {
      attempts: attempt,
      error_kind: transient.error.kind,
      error_reason: "reason" in transient.error ? transient.error.reason : null,
      note: "readiness_deadline_exhausted",
    });
    return { ready: false, reason: "observation_failed", error: transient.error };
  }
  options.trace?.("not_ready", { attempts: attempt, deadline_ms: budgetMs });
  return { ready: false, reason: "timeout", error: null };
}

export function waitForSandboxReadyWithTrace(
  options: SandboxReadyWaitOptions,
): Promise<SandboxReadyWaitResult> {
  return withSandboxReadinessTrace(
    options.sandboxName,
    { attempts: options.attempts, delay_seconds: options.delaySeconds },
    () => pollSandboxReady({ ...options, trace: addTraceEvent }),
  );
}

export function createSandboxReadyWaiter(
  deps: SandboxReadyWaitDeps,
): (
  sandboxName: string,
  attempts?: number,
  delaySeconds?: number,
) => Promise<SandboxReadyWaitResult> {
  return (sandboxName, attempts = 10, delaySeconds = 2) =>
    pollSandboxReady({
      sandboxName,
      attempts,
      delaySeconds,
      ...deps,
    });
}

export function createCliSandboxReadyWaiter(options: {
  capture: CliOpenShellSandboxObserverDeps["capture"];
  getGatewayName: () => string;
  isLinuxDockerDriverGatewayEnabled: () => boolean;
  sleep: (seconds: number) => void;
  now?: () => number;
}): ReturnType<typeof createSandboxReadyWaiter> {
  const cliDeps = { capture: options.capture };
  const observer = createCliOpenShellSandboxObserver(cliDeps);
  const fallbackReadinessProbe = createCliOpenShellLegacyPodReadinessProbe(cliDeps);
  return (sandboxName, attempts = 10, delaySeconds = 2) =>
    pollSandboxReady({
      sandboxName,
      attempts,
      delaySeconds,
      observer,
      target: namedOpenShellGateway(options.getGatewayName()),
      fallbackReadinessProbe,
      isLinuxDockerDriverGatewayEnabled: options.isLinuxDockerDriverGatewayEnabled,
      sleep: options.sleep,
      ...(options.now ? { now: options.now } : {}),
    });
}

export function waitForCreatedSandboxReadyWithTrace(options: {
  sandboxName: string;
  timeoutSecs: number;
  observer: OpenShellSandboxObserver;
  target: OpenShellGatewayTarget;
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
}): Promise<CreatedSandboxReadinessResult> {
  const { sandboxName, timeoutSecs, observer, target, sleep } = options;
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
  return withSandboxReadinessTrace(
    sandboxName,
    { timeout_seconds: timeoutSecs },
    async (): Promise<CreatedSandboxReadinessResult> => {
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
      const transient = { error: null as OpenShellSandboxError | null };
      let attempt = 0;
      let result: CreatedSandboxReadinessResult | null = null;
      await waitUntilAsync(async () => {
        attempt += 1;
        const observation = await settleSandboxObservation(() =>
          observeOpenShellSandbox(
            observer,
            target,
            sandboxName,
            remainingObservationTimeoutMs(readinessDeadlineMs, readinessNow),
          ),
        );
        if (!observation.ok) {
          if (isTransientObservationError(observation.error)) {
            consecutiveReadyPolls = 0;
            consecutiveFailurePolls = 0;
            lastFailurePhase = null;
            transient.error = observation.error;
            addTraceEvent("observation_retry", {
              attempt,
              error_kind: observation.error.kind,
              error_reason: "reason" in observation.error ? observation.error.reason : null,
            });
            return false;
          }
          addTraceEvent("observation_failed", {
            attempt,
            error_kind: observation.error.kind,
            error_reason: "reason" in observation.error ? observation.error.reason : null,
          });
          result = {
            ready: false,
            reason: "observation_failed",
            failurePhase: null,
            error: observation.error,
          };
          return true;
        }
        transient.error = null;
        const sandbox = observation.value.state === "present" ? observation.value.sandbox : null;
        if (sandbox?.readiness === "ready") {
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
        const isTerminal = sandbox?.readiness === "terminal";
        const failurePhase = isTerminal ? sandbox.phase : null;
        // Only the transient "Error" phase is debounced. It is the phase the
        // gateway briefly reports while re-registering the just-created sandbox
        // (#6043). Every other typed terminal phase must fast-fail immediately
        // rather than burn the debounce window.
        if (isTerminal && failurePhase !== "Error") {
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
      if (transient.error) {
        addTraceEvent("observation_failed", {
          attempts: attempt,
          error_kind: transient.error.kind,
          error_reason: "reason" in transient.error ? transient.error.reason : null,
          note: "readiness_deadline_exhausted",
        });
        return {
          ready: false,
          reason: "observation_failed",
          failurePhase: null,
          error: transient.error,
        };
      }
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
    },
  );
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
  if (readiness.reason === "observation_failed") {
    return `  NemoClaw could not observe readiness for sandbox '${sandboxName}'. ${readiness.error.message}`;
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
