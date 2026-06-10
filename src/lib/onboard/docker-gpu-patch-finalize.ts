// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Source-of-truth: this module is a NemoClaw-side workaround. The invalid
// state it recovers from is "OpenShell Docker-driver GPU patch left the
// sandbox in a deleted-backup / failed-new state when the post-recreate
// supervisor reconnect could not confirm the GPU container". The preferred
// source boundary for the fix is OpenShell: a Docker-driver sandbox create
// that natively accepts NVIDIA GPU access would remove the need for the
// post-create container recreation NemoClaw performs here. Until OpenShell
// supports that natively, NemoClaw recreates the container with GPU access
// and uses this module to either confirm the new container or restore the
// pre-patch backup. Regression coverage:
//   * src/lib/onboard/docker-gpu-patch-finalize.test.ts — direct unit tests
//     for finalize success / rollback / no-op / rollback failure outcomes.
//   * src/lib/onboard/docker-gpu-patch-rollback.test.ts — composed
//     recreate-with-rollback scenarios.
//   * src/lib/onboard/docker-gpu-sandbox-create.test.ts — composed create
//     flow driving maybeApplyDuringCreate → waitForSupervisorReconnect →
//     finalizeBackup.
// Removal condition: when OpenShell supports native Docker-driver GPU
// creation/reconnect, drop the NemoClaw post-create container recreation
// and delete this module along with its callers in docker-gpu-patch.ts and
// docker-gpu-sandbox-create.ts.

import {
  dockerRename as defaultDockerRename,
  dockerRm as defaultDockerRm,
  dockerStart as defaultDockerStart,
  dockerStop as defaultDockerStop,
} from "../adapters/docker";
import type { DockerGpuPatchDeps, DockerGpuPatchResult } from "./docker-gpu-patch";

const DOCKER_GPU_PATCH_TIMEOUT_MS = 30_000;

type DockerRunResult = {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

type DockerRunOptions = Record<string, unknown>;

type DockerContainerFn = (containerName: string, opts?: DockerRunOptions) => DockerRunResult;
type DockerRenameFn = (
  oldContainerName: string,
  newContainerName: string,
  opts?: DockerRunOptions,
) => DockerRunResult;

type ResolvedRollbackDeps = {
  dockerStop: DockerContainerFn;
  dockerRm: DockerContainerFn;
  dockerRename: DockerRenameFn;
  dockerStart: DockerContainerFn;
};

function isZeroStatus(result: DockerRunResult | null | undefined): boolean {
  return Number(result?.status ?? 0) === 0;
}

function resolveRollbackDeps(deps: DockerGpuPatchDeps): ResolvedRollbackDeps {
  return {
    dockerStop: deps.dockerStop ?? defaultDockerStop,
    dockerRm: deps.dockerRm ?? defaultDockerRm,
    dockerRename: deps.dockerRename ?? defaultDockerRename,
    dockerStart: deps.dockerStart ?? defaultDockerStart,
  };
}

export function rollbackToBackupContainer(
  refs: { newContainerId: string; backupContainerName: string; originalName: string },
  deps: ResolvedRollbackDeps,
): boolean {
  const containerOpts = {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  };
  deps.dockerStop(refs.newContainerId, containerOpts);
  deps.dockerRm(refs.newContainerId, containerOpts);
  const restored = deps.dockerRename(refs.backupContainerName, refs.originalName, containerOpts);
  if (!isZeroStatus(restored)) return false;
  const started = deps.dockerStart(refs.originalName, containerOpts);
  return isZeroStatus(started);
}

export type DockerGpuPatchFinalizeOptions = {
  result: DockerGpuPatchResult;
  supervisorReady: boolean;
};

export type DockerGpuPatchFinalizeOutcome = {
  backupRemoved: boolean;
  rolledBack: boolean;
};

export function finalizeDockerGpuPatchBackup(
  options: DockerGpuPatchFinalizeOptions,
  deps: DockerGpuPatchDeps = {},
): DockerGpuPatchFinalizeOutcome {
  const resolved = resolveRollbackDeps(deps);
  const containerOpts = {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  };
  if (options.result.backupRemoved) {
    return { backupRemoved: true, rolledBack: false };
  }
  if (options.supervisorReady) {
    // Backup removal is best-effort: the supervisor probe already confirmed
    // the new GPU container is reachable, so the backup is no longer needed
    // even if `docker rm` cannot delete it (e.g. concurrent admin action,
    // daemon timeout). Reflect the actual rm status in the outcome so
    // diagnostics can flag a leaked backup container.
    const rmResult = resolved.dockerRm(options.result.backupContainerName, containerOpts);
    return { backupRemoved: isZeroStatus(rmResult), rolledBack: false };
  }
  const rolledBack = rollbackToBackupContainer(
    {
      newContainerId: options.result.newContainerId,
      backupContainerName: options.result.backupContainerName,
      originalName: options.result.originalName,
    },
    resolved,
  );
  return { backupRemoved: false, rolledBack };
}

export type SupervisorReconnectOutcome =
  | { execReady: true; backupRemoved: boolean }
  | { execReady: false; rolledBack: boolean; error: Error };

export function reconcileSupervisorReconnect(
  execReady: boolean,
  refs: { newContainerId: string; backupContainerName: string; originalName: string },
  deps: DockerGpuPatchDeps,
): SupervisorReconnectOutcome {
  const resolved = resolveRollbackDeps(deps);
  const containerOpts = {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  };
  if (execReady) {
    // Backup removal is best-effort here too: the supervisor probe already
    // confirmed the new container is reachable, so a failed rm leaves a
    // leaked backup container but the user-visible sandbox is healthy.
    // Surface the actual rm status so callers can fold it into diagnostics
    // alongside the deferred-finalize path in `finalizeDockerGpuPatchBackup`.
    const rmResult = resolved.dockerRm(refs.backupContainerName, containerOpts);
    return { execReady: true, backupRemoved: isZeroStatus(rmResult) };
  }
  const rolledBack = rollbackToBackupContainer(refs, resolved);
  return {
    execReady: false,
    rolledBack,
    error: new Error(
      rolledBack
        ? "OpenShell supervisor did not reconnect to the GPU-enabled container; pre-patch sandbox restored."
        : "OpenShell supervisor did not reconnect to the GPU-enabled container and rollback failed; pre-patch sandbox was NOT restored.",
    ),
  };
}
