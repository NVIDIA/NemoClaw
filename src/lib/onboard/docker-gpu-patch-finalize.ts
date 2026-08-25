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
// and uses this module to either restore the pre-patch backup before commit or
// complete the exact stop/remove/start handoff and require OpenShell's final
// Ready acknowledgement. Before removing the old container, NemoClaw commits
// its writable layer to a temporary image and records the exact run arguments
// needed to restore it. Regression coverage:
//   * src/lib/onboard/docker-gpu-patch-finalize.test.ts — direct unit tests
//     for exact final handoff, terminal phase, rollback, and failure outcomes.
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
  type ResolvedDockerGpuPatchRollbackDeps,
  removeReplacementContainer,
  resolveDockerGpuPatchRollbackDeps,
  rollbackToBackupContainer,
} from "./docker-gpu-patch-rollback";
import {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuCloneRunOptions,
  fullDockerContainerId,
  parseDockerInspectJson,
} from "./docker-gpu-patch-clone";
import { buildDockerGpuMode } from "./docker-gpu-patch-mode";
import type {
  DockerContainerInspect,
  DockerGpuPatchDeps,
  DockerGpuPatchResult,
} from "./docker-gpu-patch-types";
import {
  waitForOpenShellFinalHandoff,
  waitForOpenShellSandboxLifecycleRelease,
} from "./docker-gpu-supervisor-reconnect";
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
      finalHandoffTimeoutSecs: number;
    };

export type DockerGpuPatchFinalizeOutcome = {
  /** True once Docker has removed the old container. */
  backupRemoved: boolean;
  rolledBack: boolean;
  rollbackImageId?: string;
  rollbackImageRemoved?: boolean;
  replacementStoppedForCommit?: boolean;
  replacementRestarted?: boolean;
  lifecycleReleaseObserved?: boolean;
  finalHandoffAcknowledged?: boolean;
  lastSandboxPhase?: string | null;
  replacementStopConfirmed?: boolean;
  replacementRemovalConfirmed?: boolean;
  replacementPresence?: "absent" | "present" | "unknown";
};

type PostCommitRollbackPlan = {
  imageId: string;
  oldContainerId: string;
  runArgs: string[];
};

const DOCKER_IMAGE_ID = /^sha256:[0-9a-f]{64}$/iu;

function removeRollbackImage(
  imageId: string,
  deps: ResolvedDockerGpuPatchRollbackDeps,
  options: Record<string, unknown>,
): boolean {
  return hasZeroDockerExitStatus(deps.dockerRun(["image", "rm", "--force", imageId], options));
}

function preparePostCommitRollback(
  result: DockerGpuPatchResult,
  resolved: ResolvedDockerGpuPatchRollbackDeps,
  options: Record<string, unknown>,
): PostCommitRollbackPlan | null {
  const oldContainerId = fullDockerContainerId(result.oldContainerId);
  if (!oldContainerId) return null;
  let inspect: DockerContainerInspect;
  try {
    inspect = parseDockerInspectJson(
      resolved.dockerCapture(["inspect", "--type", "container", oldContainerId], {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      }),
    );
  } catch {
    return null;
  }

  const committed = resolved.dockerRun(["commit", oldContainerId], options);
  if (!hasZeroDockerExitStatus(committed)) return null;
  const imageId = String(committed.stdout ?? "").trim();
  if (!DOCKER_IMAGE_ID.test(imageId)) return null;

  try {
    const cloneOptions = buildDockerGpuCloneRunOptions(inspect);
    cloneOptions.containerName = result.originalName;
    cloneOptions.image = imageId;
    return {
      imageId,
      oldContainerId,
      runArgs: buildDockerGpuCloneRunArgs(
        inspect,
        buildDockerGpuMode("startup-command"),
        cloneOptions,
      ),
    };
  } catch {
    if (!removeRollbackImage(imageId, resolved, options)) {
      console.warn(`  Could not remove temporary Docker rollback image ${imageId}.`);
    }
    return null;
  }
}

function restorePostCommitRollback(
  plan: PostCommitRollbackPlan,
  result: DockerGpuPatchResult,
  resolved: ResolvedDockerGpuPatchRollbackDeps,
  options: Record<string, unknown>,
): Pick<
  DockerGpuPatchFinalizeOutcome,
  | "rolledBack"
  | "rollbackImageId"
  | "rollbackImageRemoved"
  | "replacementStopConfirmed"
  | "replacementRemovalConfirmed"
  | "replacementPresence"
> {
  const replacementContainerId = fullDockerContainerId(result.newContainerId);
  if (!replacementContainerId) {
    return {
      rolledBack: false,
      rollbackImageId: plan.imageId,
      rollbackImageRemoved: false,
      replacementStopConfirmed: false,
      replacementRemovalConfirmed: false,
      replacementPresence: "unknown",
    };
  }
  const removal = removeReplacementContainer(replacementContainerId, resolved);
  const restored =
    removal.replacementPresence === "absent"
      ? resolved.dockerRunDetached(plan.runArgs, options)
      : null;
  const restoredContainerId =
    restored !== null && hasZeroDockerExitStatus(restored)
      ? fullDockerContainerId(String(restored.stdout ?? ""))
      : null;
  return {
    rolledBack: restoredContainerId !== null,
    rollbackImageId: plan.imageId,
    rollbackImageRemoved: false,
    ...removal,
  };
}

function isExactRunningReplacement(
  sandboxName: string,
  replacementContainerId: string,
  dockerRun: NonNullable<DockerGpuPatchDeps["dockerRun"]>,
  timeoutMs: number,
): boolean {
  const expectedContainerId = fullDockerContainerId(replacementContainerId);
  if (!expectedContainerId || timeoutMs <= 0) return false;
  try {
    const deadline = Date.now() + timeoutMs;
    const containers = queryOpenShellDockerSandboxContainers(sandboxName, { dockerRun }, timeoutMs);
    if (
      !containers.ok ||
      containers.ids.length !== 1 ||
      fullDockerContainerId(containers.ids[0]) !== expectedContainerId
    ) {
      return false;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    const inspect = dockerRun(
      [
        "inspect",
        "--type",
        "container",
        "--format",
        "{{json .State.Running}}",
        expectedContainerId,
      ],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: Math.min(DOCKER_GPU_PATCH_TIMEOUT_MS, remainingMs),
      },
    );
    return hasZeroDockerExitStatus(inspect) && String(inspect.stdout ?? "").trim() === "true";
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
    // Stop the exact replacement before retiring the exact backup, then start
    // the replacement afterward. The final start is the authoritative Docker
    // lifecycle event. Keep a committed rollback image until OpenShell accepts
    // the exact replacement as Ready (#9531).
    if (!deps.runOpenshell || !deps.runCaptureOpenshell) {
      return {
        backupRemoved: false,
        rolledBack: false,
        replacementStoppedForCommit: false,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    const stopResult = resolved.dockerStop(options.result.newContainerId, containerOpts);
    if (!hasZeroDockerExitStatus(stopResult)) {
      return {
        backupRemoved: false,
        rolledBack: false,
        replacementStoppedForCommit: false,
      };
    }
    const rollbackPlan = preparePostCommitRollback(options.result, resolved, containerOpts);
    if (!rollbackPlan) {
      const replacementRestarted = hasZeroDockerExitStatus(
        resolved.dockerStart(options.result.newContainerId, containerOpts),
      );
      return {
        backupRemoved: false,
        rolledBack: false,
        replacementStoppedForCommit: true,
        replacementRestarted,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    const rmResult = resolved.dockerRm(rollbackPlan.oldContainerId, containerOpts);
    const backupRemoved = hasZeroDockerExitStatus(rmResult);
    if (!backupRemoved) {
      const rollbackImageRemoved = removeRollbackImage(
        rollbackPlan.imageId,
        resolved,
        containerOpts,
      );
      const replacementRestarted = hasZeroDockerExitStatus(
        resolved.dockerStart(options.result.newContainerId, containerOpts),
      );
      return {
        backupRemoved: false,
        rolledBack: false,
        ...(rollbackImageRemoved
          ? { rollbackImageRemoved: true }
          : { rollbackImageId: rollbackPlan.imageId, rollbackImageRemoved: false }),
        replacementStoppedForCommit: true,
        replacementRestarted,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    console.log(
      `  Waiting for OpenShell to retire the previous lifecycle record before restarting the replacement (up to ${options.finalHandoffTimeoutSecs}s)...`,
    );
    const lifecycleReleaseObserved = waitForOpenShellSandboxLifecycleRelease(
      options.sandboxName,
      options.finalHandoffTimeoutSecs,
      {
        runOpenshell: deps.runOpenshell,
        sleep: deps.sleep,
        soleLabeledReplacementCorroboratesRetiringPhase: (remainingMs) => {
          const expectedContainerId = fullDockerContainerId(options.result.newContainerId);
          if (!expectedContainerId || remainingMs <= 0) return false;
          const containers = queryOpenShellDockerSandboxContainers(
            options.sandboxName,
            { dockerRun: resolved.dockerRun },
            remainingMs,
          );
          return (
            containers.ok &&
            containers.ids.length === 1 &&
            fullDockerContainerId(containers.ids[0]) === expectedContainerId
          );
        },
      },
    );
    if (!lifecycleReleaseObserved) {
      const rollback = restorePostCommitRollback(
        rollbackPlan,
        options.result,
        resolved,
        containerOpts,
      );
      return {
        backupRemoved: true,
        ...rollback,
        replacementStoppedForCommit: true,
        replacementRestarted: false,
        lifecycleReleaseObserved: false,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    const startResult = resolved.dockerStart(options.result.newContainerId, containerOpts);
    const replacementRestarted = hasZeroDockerExitStatus(startResult);
    if (!replacementRestarted) {
      const rollback = restorePostCommitRollback(
        rollbackPlan,
        options.result,
        resolved,
        containerOpts,
      );
      return {
        backupRemoved: true,
        ...rollback,
        replacementStoppedForCommit: true,
        replacementRestarted,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    console.log(
      `  Waiting for OpenShell to confirm the final replacement handoff (up to ${options.finalHandoffTimeoutSecs}s)...`,
    );
    const acknowledgement = waitForOpenShellFinalHandoff(
      options.sandboxName,
      options.finalHandoffTimeoutSecs,
      {
        runCaptureOpenshell: deps.runCaptureOpenshell,
        runOpenshell: deps.runOpenshell,
        sleep: deps.sleep,
        replacementIsExactAndRunning: (remainingMs) =>
          isExactRunningReplacement(
            options.sandboxName,
            options.result.newContainerId,
            resolved.dockerRun,
            remainingMs,
          ),
      },
    );
    if (!acknowledgement.acknowledged) {
      const rollback = restorePostCommitRollback(
        rollbackPlan,
        options.result,
        resolved,
        containerOpts,
      );
      return {
        backupRemoved: true,
        ...rollback,
        replacementStoppedForCommit: true,
        replacementRestarted: true,
        lifecycleReleaseObserved: true,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: acknowledgement.lastSandboxPhase,
      };
    }
    const rollbackImageRemoved = removeRollbackImage(rollbackPlan.imageId, resolved, containerOpts);
    if (!rollbackImageRemoved) {
      console.warn(`  Could not remove temporary Docker rollback image ${rollbackPlan.imageId}.`);
    }
    return {
      backupRemoved: true,
      rolledBack: false,
      ...(rollbackImageRemoved
        ? { rollbackImageRemoved: true }
        : { rollbackImageId: rollbackPlan.imageId, rollbackImageRemoved: false }),
      replacementStoppedForCommit: true,
      replacementRestarted: true,
      lifecycleReleaseObserved: true,
      finalHandoffAcknowledged: true,
      lastSandboxPhase: acknowledgement.lastSandboxPhase,
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
