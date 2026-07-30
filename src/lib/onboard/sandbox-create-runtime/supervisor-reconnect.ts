// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SUPERVISOR_RECONNECT_MIN_SECS = 900;
const SUPERVISOR_RECONNECT_COMMAND_TIMEOUT_MS = 30_000;
const SUPERVISOR_RECONNECT_ERROR_PHASE_DEFAULT_DEBOUNCE_POLLS = 60;
const SUPERVISOR_RECONNECT_POLL_INTERVAL_SECS = 2;

const TERMINAL_SANDBOX_FAILURE_PHASES = new Set(["Error", "Failed", "CrashLoopBackOff"]);
const ANSI_RE = /\x1b\[[0-9;]*m/g;

type RunResult = {
  readonly status?: number | null;
  readonly stderr?: Buffer | string | null;
  readonly stdout?: Buffer | string | null;
};

type RunOpenshell = (args: string[], options?: Record<string, unknown>) => RunResult;
type RunCaptureOpenshell = (args: string[], options?: Record<string, unknown>) => string;

export interface SupervisorReconnectDeps {
  readonly runOpenshell?: RunOpenshell;
  readonly runCaptureOpenshell?: RunCaptureOpenshell;
  readonly sleep?: (seconds: number) => void;
  readonly errorPhaseDebouncePolls?: number;
}

export interface SupervisorReconnectPolicy {
  readonly commandTimeoutMs?: number;
  readonly defaultErrorPhaseDebouncePolls?: number;
  readonly pollIntervalSecs?: number;
}

function defaultSleep(seconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, seconds) * 1000);
}

function positiveRounded(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : fallback;
}

function parseSandboxListFailurePhase(output: string, sandboxName: string): string | null {
  if (typeof output !== "string" || !output.includes(sandboxName)) return null;
  for (const line of output.replace(ANSI_RE, "").split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] === sandboxName) {
      return columns.find((column) => TERMINAL_SANDBOX_FAILURE_PHASES.has(column)) ?? null;
    }
  }
  return null;
}

function sandboxListShowsFailurePhase(
  sandboxName: string,
  runCaptureOpenshell: RunCaptureOpenshell,
  commandTimeoutMs: number,
): boolean {
  try {
    const list = runCaptureOpenshell(["sandbox", "list"], {
      ignoreError: true,
      suppressOutput: true,
      timeout: commandTimeoutMs,
    });
    return parseSandboxListFailurePhase(list, sandboxName) !== null;
  } catch {
    return false;
  }
}

/**
 * Resolve the bounded supervisor reconnect window shared by runtime adapters.
 *
 * Runtime-specific callers may layer their own environment override on top of
 * this neutral minimum without exposing that configuration to other drivers.
 */
export function resolveSupervisorReconnectTimeoutSecs(
  sandboxReadyTimeoutSecs: number,
  minimumSecs = SUPERVISOR_RECONNECT_MIN_SECS,
): number {
  return Math.max(
    positiveRounded(sandboxReadyTimeoutSecs, 1),
    positiveRounded(minimumSecs, SUPERVISOR_RECONNECT_MIN_SECS),
  );
}

/**
 * Poll the OpenShell supervisor through the public sandbox lifecycle.
 *
 * Container-driver adapters own recreation and rollback. This helper observes
 * only driver-neutral OpenShell signals: a successful sandbox exec and the
 * transient lifecycle phase reported by `sandbox list`.
 */
export function waitForSupervisorReconnect(
  sandboxName: string,
  timeoutSecs: number,
  deps: SupervisorReconnectDeps,
  policy: SupervisorReconnectPolicy = {},
): boolean {
  if (!deps.runOpenshell) return true;
  const sleep = deps.sleep ?? defaultSleep;
  const commandTimeoutMs = positiveRounded(
    policy.commandTimeoutMs ?? SUPERVISOR_RECONNECT_COMMAND_TIMEOUT_MS,
    SUPERVISOR_RECONNECT_COMMAND_TIMEOUT_MS,
  );
  const defaultErrorPhaseDebouncePolls = positiveRounded(
    policy.defaultErrorPhaseDebouncePolls ??
      SUPERVISOR_RECONNECT_ERROR_PHASE_DEFAULT_DEBOUNCE_POLLS,
    SUPERVISOR_RECONNECT_ERROR_PHASE_DEFAULT_DEBOUNCE_POLLS,
  );
  const errorPhaseDebouncePolls =
    deps.errorPhaseDebouncePolls == null || !Number.isFinite(deps.errorPhaseDebouncePolls)
      ? defaultErrorPhaseDebouncePolls
      : positiveRounded(deps.errorPhaseDebouncePolls, defaultErrorPhaseDebouncePolls);
  const pollIntervalSecs = positiveRounded(
    policy.pollIntervalSecs ?? SUPERVISOR_RECONNECT_POLL_INTERVAL_SECS,
    SUPERVISOR_RECONNECT_POLL_INTERVAL_SECS,
  );
  const deadline = Date.now() + positiveRounded(timeoutSecs, 1) * 1000;
  let consecutiveFailurePolls = 0;

  while (Date.now() <= deadline) {
    const result = deps.runOpenshell(["sandbox", "exec", "-n", sandboxName, "--", "true"], {
      ignoreError: true,
      suppressOutput: true,
      timeout: commandTimeoutMs,
    });
    if (result.status === 0) return true;
    if (
      deps.runCaptureOpenshell &&
      sandboxListShowsFailurePhase(sandboxName, deps.runCaptureOpenshell, commandTimeoutMs)
    ) {
      consecutiveFailurePolls += 1;
      if (consecutiveFailurePolls >= errorPhaseDebouncePolls) return false;
    } else {
      consecutiveFailurePolls = 0;
    }
    sleep(pollIntervalSecs);
  }
  return false;
}
