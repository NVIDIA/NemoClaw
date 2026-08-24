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
 * reproduction (for example, `gpu-e2e`) showing a transient teardown-Error that
 * recovers to Ready is the runtime evidence required.
 */

import { parseLiveSandboxEntries } from "../runtime-recovery";
import { hasZeroDockerExitStatus } from "./docker-command-result";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import { envInt } from "./env";

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

type DockerLifecycleReleaseDeps = Pick<
  DockerGpuSupervisorReconnectDeps,
  "runOpenshell" | "sleep"
> & {
  /**
   * Corroborating evidence for an Error or Deleting row from a Docker query
   * that confirms the transaction-owned replacement is the sole labeled
   * sandbox container.
   * The callback must fail closed and keep its child within the supplied
   * remaining lifecycle-release budget.
   */
  soleLabeledReplacementCorroboratesRetiringPhase?: (remainingMs: number) => boolean;
};

/**
 * Workaround contract for the OpenShell lifecycle race in #9531:
 *
 * - Removing the rollback backup can strand the exact sandbox in `Deleting`
 *   while its replacement container is healthy.
 * - `openshell sandbox list` owns lifecycle authority. Docker health cannot
 *   prove that OpenShell retired the previous record.
 * - This layer waits after backup removal and before replacement restart so
 *   OpenShell processes the stale deletion before the new registration.
 * - The caller enters this wait only after the replacement reached Ready and
 *   was deliberately stopped. A successful list normally omits the sandbox
 *   name. An Error or Deleting row is also sufficient only when a separate
 *   bounded Docker query confirms that the transaction-owned full replacement
 *   ID still identifies exactly one OpenShell-managed container. This
 *   corroborates the release condition; the OpenShell row alone is not an
 *   identity-bound ownership receipt. The Deleting case breaks the otherwise
 *   circular wait where OpenShell retains the row until that exact replacement
 *   emits its restart event.
 * - `waits for the sandbox name to disappear before restarting the
 *   replacement (#9531)` protects the event order. `rejects final handoff when
 *   OpenShell never releases the deleting lifecycle record (#9531)` protects
 *   the composed failure path.
 *
 * Remove this wait only when OpenShell binds deletion to the removed container
 * identity or provides an identity-bound lifecycle-release receipt.
 */
export function waitForOpenShellSandboxLifecycleRelease(
  sandboxName: string,
  timeoutSecs: number,
  deps: DockerLifecycleReleaseDeps,
): boolean {
  if (!deps.runOpenshell) return false;
  const sleep = deps.sleep ?? defaultSleep;
  const boundedTimeoutSecs = Math.max(1, Math.round(timeoutSecs));
  const deadline = Date.now() + boundedTimeoutSecs * 1000;
  const maxAttempts = Math.max(1, Math.ceil(boundedTimeoutSecs / 2) + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingBeforeProbeMs = deadline - Date.now();
    if (remainingBeforeProbeMs <= 0) break;
    const result = deps.runOpenshell(["sandbox", "list"], {
      ignoreError: true,
      suppressOutput: true,
      timeout: Math.min(DOCKER_GPU_PATCH_TIMEOUT_MS, remainingBeforeProbeMs),
    });
    if (hasZeroDockerExitStatus(result)) {
      const output = String(result.stdout ?? "").trim();
      const entries = parseLiveSandboxEntries(output);
      const sandboxPresent = entries.some((entry) => entry.name === sandboxName);
      const stoppedReplacementRetiring = entries.some(
        (entry) =>
          entry.name === sandboxName && (entry.phase === "Error" || entry.phase === "Deleting"),
      );
      const hasPhaseBearingEntry = entries.some((entry) => entry.phase !== null);
      const explicitEmptyList = output === "No sandboxes found" || output === "No sandboxes found.";
      const remainingBeforeCorroborationMs = deadline - Date.now();
      const soleLabeledReplacementCorroboratesRetiringPhase =
        stoppedReplacementRetiring &&
        remainingBeforeCorroborationMs > 0 &&
        deps.soleLabeledReplacementCorroboratesRetiringPhase?.(
          remainingBeforeCorroborationMs,
        ) === true;
      if (
        explicitEmptyList ||
        soleLabeledReplacementCorroboratesRetiringPhase ||
        (hasPhaseBearingEntry && !sandboxPresent)
      ) {
        return true;
      }
    }
    const remainingBeforeSleepMs = deadline - Date.now();
    if (attempt < maxAttempts && remainingBeforeSleepMs > 0) {
      sleep(Math.min(2, remainingBeforeSleepMs / 1000));
    }
  }
  return false;
}

function defaultSleep(seconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, seconds) * 1000);
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
      : // Round (not truncate) to match the env-var path's envInt rounding and
        // the sibling create/readiness debounce in sandbox-readiness-tracing.ts.
        Math.max(1, Math.round(deps.errorPhaseDebouncePolls));
  let consecutiveErrorPolls = 0;
  while (Date.now() <= deadline) {
    const result = deps.runOpenshell(["sandbox", "exec", "-n", sandboxName, "--", "true"], {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    if (hasZeroDockerExitStatus(result)) return true;
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
