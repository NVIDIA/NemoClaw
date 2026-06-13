// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Supervisor-reconnect wait for the Docker GPU patch path.
 *
 * Source-of-truth boundary
 * ------------------------
 * The transient Error phase this module debounces is observed in the
 * `openshell sandbox list` cache while the OpenShell host re-registers the
 * newly-recreated GPU container after `docker stop` + `docker run`. The
 * preferred fix lives at the OpenShell gateway: `sandbox list` should not
 * report a terminal phase for a sandbox whose Docker container is being
 * recreated by the GPU patch path. Until that upstream change ships,
 * NemoClaw tolerates the transient Error at this layer via a
 * consecutive-poll debounce.
 *
 * Removal condition
 * -----------------
 * Delete this debounce once OpenShell guarantees `sandbox list` skips the
 * brief Error transition during a known recreate. A real-Docker GPU E2E
 * reproduction (e.g. `e2e-branch-validation:gpu`,
 * `gpu-repo-local-ollama-openclaw`) showing a transient teardown-Error that
 * recovers to Ready is the runtime evidence required.
 */

import { envInt } from "./env";

const DOCKER_GPU_PATCH_TIMEOUT_MS = 30_000;
const DOCKER_GPU_SUPERVISOR_RECONNECT_MIN_SECS = 900;
// Default consecutive Error-phase polls required before fast-fail. With a
// 2-second poll interval this is ~2 minutes of sustained Error, leaving
// headroom for Docker-CDI GPU runners whose OpenShell sandbox-list row can
// stay Error for longer than the original ~30s window while the recreated
// container is still reconnecting (#4948). Hosts that genuinely crashed on
// startup still hit the rollback path well before the full reconnect timeout.
//
// Alternative considered: branching on Docker State.Status + Health.Status
// to keep retrying when the patched container reports Status=running plus
// Health=starting. Rejected because the patched container's Health depends
// on the OpenShell supervisor script — the same signal this wait observes
// via `openshell sandbox list` — so Docker Health is either redundant or
// lags by several seconds. The debounce-plus-rollback path also guarantees
// the user keeps the pre-patch CPU sandbox on reconnect failure, which a
// Health-aware retry alone would not provide. If a future repro shows
// Status=running + Health=starting genuinely failing reconnect after this
// default window, switch to a Health-aware retry, but extract Docker health
// probing into a separate observation channel first rather than overloading
// this one.
const DOCKER_GPU_SUPERVISOR_RECONNECT_ERROR_PHASE_DEFAULT_DEBOUNCE_POLLS = 60;

export const DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT_ENV =
  "NEMOCLAW_DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT";
export const DOCKER_GPU_SUPERVISOR_RECONNECT_ERROR_DEBOUNCE_ENV =
  "NEMOCLAW_DOCKER_GPU_SUPERVISOR_RECONNECT_ERROR_DEBOUNCE";

const TERMINAL_SANDBOX_FAILURE_PHASES = new Set(["Error", "Failed", "CrashLoopBackOff"]);

type DockerRunResult = {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

type RunOpenshellFn = (args: string[], opts?: Record<string, unknown>) => DockerRunResult;
type RunCaptureOpenshellFn = (args: string[], opts?: Record<string, unknown>) => string;

export type DockerGpuSupervisorReconnectDeps = {
  runOpenshell?: RunOpenshellFn;
  runCaptureOpenshell?: RunCaptureOpenshellFn;
  sleep?: (seconds: number) => void;
  errorPhaseDebouncePolls?: number;
};

function defaultSleep(seconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, seconds) * 1000);
}

function isZeroStatus(result: DockerRunResult | null | undefined): boolean {
  return Number(result?.status ?? 0) === 0;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function parseSandboxListFailurePhase(output: string, sandboxName: string): string | null {
  if (typeof output !== "string" || !output.includes(sandboxName)) return null;
  for (const line of output.replace(ANSI_RE, "").split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === sandboxName) {
      return cols.find((col) => TERMINAL_SANDBOX_FAILURE_PHASES.has(col)) ?? null;
    }
  }
  return null;
}

function sandboxListShowsErrorPhase(
  sandboxName: string,
  runCaptureOpenshell: RunCaptureOpenshellFn,
): boolean {
  try {
    const list = runCaptureOpenshell(["sandbox", "list"], {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    return parseSandboxListFailurePhase(list, sandboxName) !== null;
  } catch {
    return false;
  }
}

export function waitForOpenShellSupervisorReconnect(
  sandboxName: string,
  timeoutSecs: number,
  deps: DockerGpuSupervisorReconnectDeps,
): boolean {
  if (!deps.runOpenshell) return true;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + Math.max(1, timeoutSecs) * 1000;
  const errorPhaseDebouncePolls =
    deps.errorPhaseDebouncePolls == null || !Number.isFinite(deps.errorPhaseDebouncePolls)
      ? getDockerGpuSupervisorReconnectErrorDebouncePolls()
      : Math.max(1, Math.trunc(deps.errorPhaseDebouncePolls));
  let consecutiveErrorPolls = 0;
  while (Date.now() <= deadline) {
    const result = deps.runOpenshell(["sandbox", "exec", "-n", sandboxName, "--", "true"], {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    if (isZeroStatus(result)) return true;
    if (
      deps.runCaptureOpenshell &&
      sandboxListShowsErrorPhase(sandboxName, deps.runCaptureOpenshell)
    ) {
      consecutiveErrorPolls += 1;
      if (consecutiveErrorPolls >= errorPhaseDebouncePolls) return false;
    } else {
      consecutiveErrorPolls = 0;
    }
    sleep(2);
  }
  return false;
}

export function getDockerGpuSupervisorReconnectTimeoutSecs(
  sandboxReadyTimeoutSecs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const readyTimeoutSecs = Number.isFinite(sandboxReadyTimeoutSecs)
    ? Math.max(1, Math.round(sandboxReadyTimeoutSecs))
    : 1;
  const fallback = Math.max(readyTimeoutSecs, DOCKER_GPU_SUPERVISOR_RECONNECT_MIN_SECS);
  return Math.max(1, envInt(DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT_ENV, fallback, env));
}

export function getDockerGpuSupervisorReconnectErrorDebouncePolls(
  env: Record<string, string | undefined> = process.env,
): number {
  return Math.max(
    1,
    envInt(
      DOCKER_GPU_SUPERVISOR_RECONNECT_ERROR_DEBOUNCE_ENV,
      DOCKER_GPU_SUPERVISOR_RECONNECT_ERROR_PHASE_DEFAULT_DEBOUNCE_POLLS,
      env,
    ),
  );
}
