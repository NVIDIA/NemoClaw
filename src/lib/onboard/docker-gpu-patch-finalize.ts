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
// complete the OpenShell stop / exact remove / OpenShell start handoff and
// require OpenShell's final Ready acknowledgement. Removing the old container
// is the irreversible commit point: later failures require a sandbox rebuild
// rather than automatic rollback. Regression coverage:
//   * src/lib/onboard/docker-gpu-patch-finalize.test.ts — direct unit tests
//     for exact final handoff, terminal phase, rollback, and failure outcomes.
//   * src/lib/onboard/docker-gpu-patch-rollback.test.ts — composed
//     recreate-with-rollback scenarios.
//   * src/lib/onboard/docker-gpu-sandbox-create-lifecycle.test.ts — composed create
//     flow driving maybeApplyDuringCreate → waitForSupervisorReconnect →
//     finalizeBackup.
// Removal condition: when OpenShell supports native Docker-driver GPU
// creation/reconnect, drop the NemoClaw post-create container recreation
// and delete this module along with its direct callers in
// docker-gpu-patch-recreate.ts, docker-gpu-sandbox-create.ts, and
// src/lib/actions/sandbox/supervisor-relaunch.ts.

import { hasZeroDockerExitStatus } from "./docker-command-result";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import {
  resolveDockerGpuPatchRollbackDeps,
  rollbackToBackupContainer,
} from "./docker-gpu-patch-rollback";
import { fullDockerContainerId } from "./docker-gpu-patch-clone";
import type { DockerGpuPatchDeps, DockerGpuPatchResult } from "./docker-gpu-patch-types";
import { waitForOpenShellFinalHandoff } from "./docker-gpu-supervisor-reconnect";
import {
  OPENSHELL_SANDBOX_NAMESPACE_LABEL,
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
  /** True once the old container has crossed the irreversible removal boundary. */
  backupRemoved: boolean;
  rolledBack: boolean;
  replacementStoppedForCommit?: boolean;
  replacementRestarted?: boolean;
  lifecycleStopAcknowledged?: boolean;
  finalHandoffAcknowledged?: boolean;
  lastSandboxPhase?: string | null;
  replacementStopConfirmed?: boolean;
  replacementRemovalConfirmed?: boolean;
  replacementPresence?: "absent" | "present" | "unknown";
};

const PROCESS_TREE_BOUNDED_OPENSHELL_OPTIONS = {
  killProcessTreeOnTimeout: true,
  killSignal: "SIGKILL",
} as const;

function runOpenShellLifecycleCommand(
  runOpenshell: NonNullable<DockerGpuPatchDeps["runOpenshell"]>,
  args: string[],
  timeoutSecs: number,
): boolean {
  try {
    return hasZeroDockerExitStatus(
      runOpenshell(args, {
        ignoreError: true,
        ...PROCESS_TREE_BOUNDED_OPENSHELL_OPTIONS,
        suppressOutput: true,
        timeout: Math.max(1, Math.round(timeoutSecs * 1000)),
      }),
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
    const namespace = dockerRun(
      [
        "inspect",
        "--type",
        "container",
        "--format",
        `{{ index .Config.Labels "${OPENSHELL_SANDBOX_NAMESPACE_LABEL}" }}`,
        expectedContainerId,
      ],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: Math.min(DOCKER_GPU_PATCH_TIMEOUT_MS, timeoutMs),
      },
    );
    const sandboxNamespace = String(namespace.stdout ?? "").trim();
    if (
      !hasZeroDockerExitStatus(namespace) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(sandboxNamespace)
    ) {
      return false;
    }
    let remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    const containers = queryOpenShellDockerSandboxContainers(
      sandboxName,
      { dockerRun },
      remainingMs,
      sandboxNamespace,
    );
    if (
      !containers.ok ||
      containers.ids.length !== 1 ||
      fullDockerContainerId(containers.ids[0]) !== expectedContainerId
    ) {
      return false;
    }
    remainingMs = deadline - Date.now();
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
    // Move the durable OpenShell row to Stopped before touching the exact
    // containers. OpenShell 0.0.106 keeps Stopped stable while the Docker
    // driver's duplicate-ID snapshot catches up with removal of the rollback
    // container. Starting through OpenShell then owns the lifecycle fence and
    // prevents the stopped replacement snapshot from regressing the row to
    // Error or sticky Deleting. Backup removal remains the irreversible commit
    // point; failures after it require a sandbox rebuild. Success is withheld
    // until OpenShell reports Ready and Docker still proves the exact
    // replacement is the sole running labeled container (#9531, #10153).
    if (!deps.runOpenshell || !deps.runCaptureOpenshell) {
      return {
        backupRemoved: false,
        rolledBack: false,
        replacementStoppedForCommit: false,
        lifecycleStopAcknowledged: false,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    console.log(
      `  Stopping the replacement through OpenShell for the final handoff (up to ${options.finalHandoffTimeoutSecs}s)...`,
    );
    const lifecycleStopAcknowledged = runOpenShellLifecycleCommand(
      deps.runOpenshell,
      ["sandbox", "stop", options.sandboxName],
      options.finalHandoffTimeoutSecs,
    );
    if (!lifecycleStopAcknowledged) {
      return {
        backupRemoved: false,
        rolledBack: false,
        replacementStoppedForCommit: false,
        lifecycleStopAcknowledged: false,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    const stopResult = resolved.dockerStop(options.result.newContainerId, containerOpts);
    if (!hasZeroDockerExitStatus(stopResult)) {
      const replacementRestarted = runOpenShellLifecycleCommand(
        deps.runOpenshell,
        ["sandbox", "start", options.sandboxName],
        options.finalHandoffTimeoutSecs,
      );
      return {
        backupRemoved: false,
        rolledBack: false,
        replacementStoppedForCommit: false,
        replacementRestarted,
        lifecycleStopAcknowledged: true,
      };
    }
    const rmResult = resolved.dockerRm(options.result.oldContainerId, containerOpts);
    const backupRemoved = hasZeroDockerExitStatus(rmResult);
    if (!backupRemoved) {
      const replacementRestarted = runOpenShellLifecycleCommand(
        deps.runOpenshell,
        ["sandbox", "start", options.sandboxName],
        options.finalHandoffTimeoutSecs,
      );
      return {
        backupRemoved: false,
        rolledBack: false,
        replacementStoppedForCommit: true,
        replacementRestarted,
        lifecycleStopAcknowledged: true,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    console.log(
      `  Starting the exact replacement through OpenShell to complete the final handoff (up to ${options.finalHandoffTimeoutSecs}s)...`,
    );
    const replacementRestarted = runOpenShellLifecycleCommand(
      deps.runOpenshell,
      ["sandbox", "start", options.sandboxName],
      options.finalHandoffTimeoutSecs,
    );
    if (!replacementRestarted) {
      return {
        backupRemoved: true,
        rolledBack: false,
        replacementStoppedForCommit: true,
        replacementRestarted: false,
        lifecycleStopAcknowledged: true,
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
      lifecycleStopAcknowledged: true,
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
