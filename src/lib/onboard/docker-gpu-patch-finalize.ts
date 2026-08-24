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
// Ready acknowledgement. Regression coverage:
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
  resolveDockerGpuPatchRollbackDeps,
  rollbackToBackupContainer,
} from "./docker-gpu-patch-rollback";
import { fullDockerContainerId } from "./docker-gpu-patch-clone";
import type { DockerGpuPatchDeps, DockerGpuPatchResult } from "./docker-gpu-patch-types";
import {
  waitForOpenShellFinalHandoff,
  waitForOpenShellSandboxLifecycleRelease,
} from "./docker-gpu-supervisor-reconnect";
import {
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_MANAGED_BY_VALUE,
  queryOpenShellDockerSandboxContainers,
} from "./openshell-docker-sandbox-containers";

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
  backupRemoved: boolean;
  rolledBack: boolean;
  replacementStoppedForCommit?: boolean;
  replacementRestarted?: boolean;
  lifecycleReleaseObserved?: boolean;
  finalHandoffAcknowledged?: boolean;
  lastSandboxPhase?: string | null;
  replacementStopConfirmed?: boolean;
  replacementRemovalConfirmed?: boolean;
  replacementPresence?: "absent" | "present" | "unknown";
};

function isSoleLabeledReplacement(
  replacementContainerId: string,
  dockerRun: NonNullable<DockerGpuPatchDeps["dockerRun"]>,
  timeoutMs: number,
): boolean {
  const expectedContainerId = fullDockerContainerId(replacementContainerId);
  if (!expectedContainerId || timeoutMs <= 0) return false;
  try {
    const query = dockerRun(
      [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `id=${expectedContainerId}`,
        "--filter",
        `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
        "--format",
        "{{.ID}}",
      ],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: Math.max(1, Math.min(DOCKER_GPU_PATCH_TIMEOUT_MS, Math.floor(timeoutMs))),
      },
    );
    if (!hasZeroDockerExitStatus(query)) return false;
    const containerIds = String(query.stdout ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    return (
      containerIds.length === 1 &&
      fullDockerContainerId(containerIds[0]) === expectedContainerId
    );
  } catch {
    return false;
  }
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
    // lifecycle event. Success is withheld until OpenShell reports Ready and
    // Docker still proves the exact replacement is the sole running labeled
    // container (#9531).
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
    const rmResult = resolved.dockerRm(options.result.oldContainerId, containerOpts);
    const backupRemoved = hasZeroDockerExitStatus(rmResult);
    if (!backupRemoved) {
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
    console.log(
      `  Waiting for OpenShell to retire the previous lifecycle record before restarting the replacement (up to ${options.finalHandoffTimeoutSecs}s)...`,
    );
    const lifecycleReleaseObserved = waitForOpenShellSandboxLifecycleRelease(
      options.sandboxName,
      options.finalHandoffTimeoutSecs,
      {
        runOpenshell: deps.runOpenshell,
        sleep: deps.sleep,
        soleLabeledReplacementCorroboratesRetiringPhase: (remainingMs) =>
          isSoleLabeledReplacement(
            options.result.newContainerId,
            resolved.dockerRun,
            remainingMs,
          ),
      },
    );
    if (!lifecycleReleaseObserved) {
      return {
        backupRemoved: true,
        rolledBack: false,
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
      return {
        backupRemoved: true,
        rolledBack: false,
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
    return {
      backupRemoved: true,
      rolledBack: false,
      replacementStoppedForCommit: true,
      replacementRestarted: true,
      lifecycleReleaseObserved: true,
      finalHandoffAcknowledged: acknowledgement.acknowledged,
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
