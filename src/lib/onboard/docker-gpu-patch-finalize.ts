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
import { fullDockerContainerId } from "./docker-gpu-patch-clone";
import type { DockerGpuPatchDeps, DockerGpuPatchResult } from "./docker-gpu-patch-types";
import { waitForOpenShellSandboxLifecycleRelease } from "./docker-gpu-supervisor-reconnect";
import { queryOpenShellDockerSandboxContainers } from "./openshell-docker-sandbox-containers";

export {
  restoreDockerGpuPatchBackupAfterRecreateFailure as rollbackDockerGpuPatchOnRecreateFailure,
  rollbackToBackupContainer,
} from "./docker-gpu-patch-rollback";

export type DockerGpuPatchFinalizeOptions =
  | {
      result: DockerGpuPatchResult;
      supervisorReady: false;
    }
  | {
      result: DockerGpuPatchResult;
      supervisorReady: true;
      sandboxName: string;
      lifecycleReleaseTimeoutSecs: number;
    };

export type DockerGpuPatchFinalizeOutcome = {
  backupRemoved: boolean;
  rolledBack: boolean;
  replacementStoppedForCommit?: boolean;
  replacementRestarted?: boolean;
  lifecycleReleaseObserved?: boolean;
  replacementStopConfirmed?: boolean;
  replacementRemovalConfirmed?: boolean;
  replacementPresence?: "absent" | "present" | "unknown";
};

function isSoleLabeledReplacement(
  sandboxName: string,
  replacementContainerId: string,
  dockerRun: NonNullable<DockerGpuPatchDeps["dockerRun"]>,
  timeoutMs: number,
): boolean {
  const expectedContainerId = fullDockerContainerId(replacementContainerId);
  if (!expectedContainerId || timeoutMs <= 0) return false;
  try {
    const containers = queryOpenShellDockerSandboxContainers(sandboxName, { dockerRun }, timeoutMs);
    return (
      containers.ok &&
      containers.ids.length === 1 &&
      fullDockerContainerId(containers.ids[0]) === expectedContainerId
    );
  } catch {
    return false;
  }
}

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
    // Stop the replacement before retiring the labelled backup, then start it
    // afterward. OpenShell observes Docker lifecycle events for both containers;
    // leaving the backup's removal as the final event can demote the already
    // reconnected replacement back to not-ready. The final start makes the live
    // replacement's registration authoritative while the rollback container is
    // still retained until the destructive removal succeeds.
    const stopResult = resolved.dockerStop(options.result.newContainerId, containerOpts);
    if (!hasZeroDockerExitStatus(stopResult)) {
      return {
        backupRemoved: false,
        rolledBack: false,
        replacementStoppedForCommit: false,
      };
    }
    const rmResult = resolved.dockerRm(options.result.backupContainerName, containerOpts);
    const backupRemoved = hasZeroDockerExitStatus(rmResult);
    const sandboxName = options.sandboxName;
    const lifecycleReleaseTimeoutSecs = options.lifecycleReleaseTimeoutSecs;
    const hasLifecycleContext =
      sandboxName.length > 0 &&
      Number.isFinite(lifecycleReleaseTimeoutSecs) &&
      lifecycleReleaseTimeoutSecs > 0;
    if (backupRemoved && hasLifecycleContext) {
      console.log(
        `  Waiting for OpenShell to retire the previous lifecycle record before restarting the replacement (up to ${lifecycleReleaseTimeoutSecs}s)...`,
      );
    }
    const lifecycleReleaseObserved =
      backupRemoved && hasLifecycleContext
        ? waitForOpenShellSandboxLifecycleRelease(sandboxName, lifecycleReleaseTimeoutSecs, {
            runOpenshell: deps.runOpenshell,
            sleep: deps.sleep,
            soleLabeledReplacementCorroboratesRetiringPhase: (remainingMs) =>
              isSoleLabeledReplacement(
                sandboxName,
                options.result.newContainerId,
                resolved.dockerRun,
                remainingMs,
              ),
          })
        : false;
    if (!lifecycleReleaseObserved) {
      return {
        backupRemoved,
        rolledBack: false,
        replacementStoppedForCommit: true,
        replacementRestarted: false,
        lifecycleReleaseObserved: false,
      };
    }
    const startResult = resolved.dockerStart(options.result.newContainerId, containerOpts);
    return {
      backupRemoved,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: hasZeroDockerExitStatus(startResult),
      lifecycleReleaseObserved: true,
    };
  }
  const rollback = rollbackToBackupContainer(
    {
      newContainerId: options.result.newContainerId,
      backupContainerName: options.result.backupContainerName,
      originalName: options.result.originalName,
    },
    resolved,
  );
  return { backupRemoved: false, ...rollback };
}

export type SupervisorReconnectOutcome =
  | { execReady: true; backupRemoved: boolean }
  | ({ execReady: false; error: Error } & Omit<DockerGpuPatchFinalizeOutcome, "backupRemoved">);

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
  const rollback = rollbackToBackupContainer(refs, resolved);
  return {
    execReady: false,
    ...rollback,
    error: new Error(
      rollback.rolledBack
        ? "OpenShell supervisor did not reconnect to the GPU-enabled container; pre-patch sandbox restored."
        : "OpenShell supervisor did not reconnect to the GPU-enabled container and rollback failed; pre-patch sandbox was NOT restored.",
    ),
  };
}
