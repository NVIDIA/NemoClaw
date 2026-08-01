// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  finalizePodmanManagedSandbox,
  findPodmanManagedSandboxContainerIds,
  type PodmanManagedSandboxRecreateDeps,
  type PodmanManagedSandboxRecreateTransaction,
  type PodmanOpenShellWatcherController,
  recreatePodmanManagedSandbox,
} from "../compute/podman/sandbox-recreate";
import type { PodmanGpuAttachment } from "../compute/podman/gpu-attachment";
import {
  assertPodmanSocketAuthority,
  type PodmanSocketAuthority,
} from "../compute/podman/socket-authority";
import {
  applyPodmanManagedStartupRootRequest,
  getPodmanManagedStartupFailureTransaction,
  type PodmanManagedStartupTransaction,
} from "../managed-startup/podman-root-apply";
import { finalizePodmanManagedStartupSharedState } from "../managed-startup/podman-shared-state";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import {
  resolveSupervisorReconnectTimeoutSecs,
  waitForSupervisorReconnect,
} from "./supervisor-reconnect";
import type { SandboxCreateRuntimePatch } from "./types";

type RunOpenshell = (
  args: string[],
  options?: Record<string, unknown>,
) => {
  readonly status?: number | null;
  readonly stderr?: Buffer | string | null;
  readonly stdout?: Buffer | string | null;
};
type RunCaptureOpenshell = (args: string[], options?: { ignoreError?: boolean }) => string;
type WaitForSupervisor = typeof waitForSupervisorReconnect;

export interface PodmanSandboxCreatePatchOptions {
  readonly gpuAttachment?: PodmanGpuAttachment | null;
  readonly managedStartupRootApplyRequest?: ManagedStartupRootApplyRequest | null;
  readonly openshellSandboxCommand: readonly string[];
  readonly persistStartupCommand: boolean;
  readonly requiredUlimits?:
    | readonly {
        readonly hard: number;
        readonly name: string;
        readonly soft: number;
      }[]
    | null;
  readonly sandboxName: string;
  readonly socketAuthority: PodmanSocketAuthority;
  readonly socketPath: string;
  readonly timeoutSecs: number;
  readonly watcherController: PodmanOpenShellWatcherController;
  readonly deps: {
    readonly runCaptureOpenshell: RunCaptureOpenshell;
    readonly runOpenshell: RunOpenshell;
    readonly sleep: (seconds: number) => void;
    readonly assertSocketAuthority?: typeof assertPodmanSocketAuthority;
    readonly runPodman?: PodmanManagedSandboxRecreateDeps["run"];
  };
  readonly overrides?: {
    readonly applyRoot?: typeof applyPodmanManagedStartupRootRequest;
    readonly fail?: (sandboxName: string, error: unknown) => void;
    readonly finalizeRecreation?: typeof finalizePodmanManagedSandbox;
    readonly finalizeSharedState?: typeof finalizePodmanManagedStartupSharedState;
    readonly findContainerIds?: typeof findPodmanManagedSandboxContainerIds;
    readonly recreate?: typeof recreatePodmanManagedSandbox;
    readonly waitForSupervisor?: WaitForSupervisor;
  };
}

function defaultFailure(sandboxName: string, error: unknown): never {
  console.error("");
  console.error(
    `  Podman managed-startup cutover failed for sandbox '${sandboxName}': ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}

/**
 * Compose the Podman container recreation and managed-startup transactions
 * behind the same create-stream lifecycle used by Docker.
 */
export function createPodmanSandboxCreatePatch(
  options: PodmanSandboxCreatePatchOptions,
): SandboxCreateRuntimePatch {
  const findContainerIds =
    options.overrides?.findContainerIds ?? findPodmanManagedSandboxContainerIds;
  const recreate = options.overrides?.recreate ?? recreatePodmanManagedSandbox;
  const applyRoot = options.overrides?.applyRoot ?? applyPodmanManagedStartupRootRequest;
  const finalizeSharedState =
    options.overrides?.finalizeSharedState ?? finalizePodmanManagedStartupSharedState;
  const finalizeRecreation = options.overrides?.finalizeRecreation ?? finalizePodmanManagedSandbox;
  const waitForSupervisor = options.overrides?.waitForSupervisor ?? waitForSupervisorReconnect;
  const fail = options.overrides?.fail ?? defaultFailure;
  const proveSocketAuthority = options.deps.assertSocketAuthority ?? assertPodmanSocketAuthority;
  const podmanDeps = {
    assertSocketAuthority: proveSocketAuthority,
    ...(options.deps.runPodman ? { run: options.deps.runPodman } : {}),
    socketAuthority: options.socketAuthority,
  };
  const patchEnabled =
    options.persistStartupCommand ||
    options.managedStartupRootApplyRequest != null ||
    options.gpuAttachment != null;

  let recreation: PodmanManagedSandboxRecreateTransaction | null = null;
  let managedStartup: PodmanManagedStartupTransaction | null = null;
  let applied = false;
  let finalized = false;
  let needsSupervisorWait = false;
  let patchError: unknown = null;

  const rollback = (): Error | null => {
    if (finalized || (!managedStartup && !recreation)) return null;
    try {
      proveSocketAuthority(options.socketAuthority);
      if (managedStartup) {
        finalizeSharedState(
          {
            containerRollbackAuthority: recreation,
            supervisorReady: false,
            transaction: managedStartup,
          },
          podmanDeps,
        );
        managedStartup = null;
      }
      if (recreation) {
        proveSocketAuthority(options.socketAuthority);
        const outcome = finalizeRecreation(
          {
            replacementReady: false,
            transaction: recreation,
            watcherController: options.watcherController,
          },
          podmanDeps,
        );
        if (!outcome.rolledBack) {
          throw new Error("Podman sandbox recreation rollback could not be proven.");
        }
      }
      finalized = true;
      needsSupervisorWait = false;
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };

  const failWithRollback = (error: unknown): void => {
    const rollbackError = rollback();
    const primary = error instanceof Error ? error : new Error(String(error));
    fail(
      options.sandboxName,
      rollbackError
        ? new Error(`${primary.message}; Podman rollback failed: ${rollbackError.message}`)
        : primary,
    );
  };

  const apply = (): void => {
    proveSocketAuthority(options.socketAuthority);
    recreation = recreate(
      {
        command: options.openshellSandboxCommand,
        gpuAttachment: options.gpuAttachment,
        ...(options.requiredUlimits ? { requiredUlimits: options.requiredUlimits } : {}),
        sandboxName: options.sandboxName,
        socketAuthority: options.socketAuthority,
        socketPath: options.socketPath,
        watcherController: options.watcherController,
      },
      podmanDeps,
    );
    proveSocketAuthority(options.socketAuthority);
    needsSupervisorWait = true;
    const request = options.managedStartupRootApplyRequest;
    if (request) {
      proveSocketAuthority(options.socketAuthority);
      managedStartup = applyRoot(
        {
          containerId: recreation.newContainerId,
          request,
          socketAuthority: options.socketAuthority,
          socketPath: options.socketPath,
        },
        podmanDeps,
      );
      proveSocketAuthority(options.socketAuthority);
    }
    applied = true;
  };

  const applyOrCaptureError = (): void => {
    try {
      apply();
    } catch (error) {
      managedStartup ??= getPodmanManagedStartupFailureTransaction(error);
      patchError = error;
    }
  };

  return {
    revalidateBeforeMutation() {
      proveSocketAuthority(options.socketAuthority);
    },

    maybeApplyDuringCreate() {
      if (!patchEnabled || applied || patchError) return;
      proveSocketAuthority(options.socketAuthority);
      const containerIds = findContainerIds(options.socketPath, options.sandboxName, podmanDeps);
      if (containerIds.length === 0) return;
      if (containerIds.length !== 1) {
        patchError = new Error(
          `Podman managed startup observed ${String(
            containerIds.length,
          )} matching containers and refused an ambiguous cutover.`,
        );
        return;
      }
      applyOrCaptureError();
    },

    createFailureMessage() {
      return patchError
        ? "Podman managed startup failed while OpenShell sandbox create was still waiting."
        : null;
    },

    exitOnPatchError() {
      if (patchError) failWithRollback(patchError);
    },

    rollbackManagedStartupAfterCreateFailure() {
      const error = rollback();
      if (error) fail(options.sandboxName, error);
    },

    ensureApplied() {
      if (!patchEnabled || applied) return;
      applyOrCaptureError();
      if (patchError) failWithRollback(patchError);
    },

    waitForSupervisorReconnectIfNeeded() {
      if (!needsSupervisorWait || finalized) return;
      proveSocketAuthority(options.socketAuthority);
      const timeoutSecs = resolveSupervisorReconnectTimeoutSecs(options.timeoutSecs);
      const ready = waitForSupervisor(options.sandboxName, timeoutSecs, {
        runOpenshell: options.deps.runOpenshell,
        runCaptureOpenshell: options.deps.runCaptureOpenshell,
        sleep: options.deps.sleep,
      });
      if (ready) {
        proveSocketAuthority(options.socketAuthority);
        needsSupervisorWait = false;
        return;
      }
      failWithRollback(
        new Error("OpenShell supervisor did not reconnect to the recreated Podman container."),
      );
    },

    commitAfterReady() {
      if (finalized || (!managedStartup && !recreation)) return;
      if (needsSupervisorWait) {
        failWithRollback(
          new Error("Podman managed startup cannot commit before supervisor reconnect."),
        );
        return;
      }
      if (managedStartup) {
        proveSocketAuthority(options.socketAuthority);
        let shared: ReturnType<typeof finalizePodmanManagedStartupSharedState>;
        try {
          shared = finalizeSharedState(
            {
              containerRollbackAuthority: recreation,
              supervisorReady: true,
              transaction: managedStartup,
            },
            podmanDeps,
          );
        } catch (error) {
          failWithRollback(error);
          return;
        }
        managedStartup = null;
        if (!shared.supervisorReady || shared.failure) {
          failWithRollback(shared.failure ?? new Error("Podman shared-state commit failed."));
          return;
        }
      }
      if (recreation) {
        proveSocketAuthority(options.socketAuthority);
        const outcome = finalizeRecreation(
          { replacementReady: true, transaction: recreation },
          podmanDeps,
        );
        if (!outcome.backupRemoved) {
          fail(
            options.sandboxName,
            new Error(
              "Podman managed startup passed Ready, but its rollback backup could not be removed.",
            ),
          );
          return;
        }
      }
      proveSocketAuthority(options.socketAuthority);
      finalized = true;
    },
  };
}
