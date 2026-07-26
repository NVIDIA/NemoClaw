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

import { hasZeroDockerExitStatus } from "./docker-command-result";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import {
  resolveDockerGpuPatchRollbackDeps,
  rollbackToBackupContainer,
} from "./docker-gpu-patch-rollback";
import type { DockerGpuPatchDeps, DockerGpuPatchResult } from "./docker-gpu-patch-types";

export {
  restoreDockerGpuPatchBackupAfterRecreateFailure as rollbackDockerGpuPatchOnRecreateFailure,
  rollbackToBackupContainer,
} from "./docker-gpu-patch-rollback";

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
  const resolved = resolveDockerGpuPatchRollbackDeps(deps);
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
    return { backupRemoved: hasZeroDockerExitStatus(rmResult), rolledBack: false };
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
  const resolved = resolveDockerGpuPatchRollbackDeps(deps);
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
    return { execReady: true, backupRemoved: hasZeroDockerExitStatus(rmResult) };
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
