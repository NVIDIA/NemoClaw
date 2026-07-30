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

import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import { envInt } from "./env";
import {
  resolveSupervisorReconnectTimeoutSecs,
  type SupervisorReconnectDeps,
  waitForSupervisorReconnect,
} from "./sandbox-create-runtime/supervisor-reconnect";

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

export type DockerGpuSupervisorReconnectDeps = SupervisorReconnectDeps;

export function waitForOpenShellSupervisorReconnect(
  sandboxName: string,
  timeoutSecs: number,
  deps: DockerGpuSupervisorReconnectDeps,
): boolean {
  const errorPhaseDebouncePolls =
    deps.errorPhaseDebouncePolls == null || !Number.isFinite(deps.errorPhaseDebouncePolls)
      ? getDockerGpuSupervisorReconnectErrorDebouncePolls()
      : deps.errorPhaseDebouncePolls;
  return waitForSupervisorReconnect(
    sandboxName,
    timeoutSecs,
    { ...deps, errorPhaseDebouncePolls },
    { commandTimeoutMs: DOCKER_GPU_PATCH_TIMEOUT_MS },
  );
}

export function getDockerGpuSupervisorReconnectTimeoutSecs(
  sandboxReadyTimeoutSecs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const fallback = resolveSupervisorReconnectTimeoutSecs(
    sandboxReadyTimeoutSecs,
    DOCKER_GPU_SUPERVISOR_RECONNECT_MIN_SECS,
  );
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
