// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandboxFailurePhase } from "../state/gateway";
import type { SandboxGpuProofResult } from "../state/registry";
import {
  getDockerGpuSupervisorReconnectTimeoutSecs,
  printDockerGpuPatchFailureAndExit,
  printDockerGpuProofFailure,
  printDockerGpuReadinessFailure,
  recreateOpenShellDockerSandboxWithGpu,
  waitForOpenShellSupervisorReconnect,
} from "./docker-gpu-patch";
import { finalizeDockerGpuPatchBackup } from "./docker-gpu-patch-finalize";
import type {
  DockerGpuPatchBackend,
  DockerGpuPatchDeps,
  DockerGpuPatchFailureContext,
  DockerGpuPatchMode,
  DockerGpuPatchResult,
} from "./docker-gpu-patch-types";
import { captureDockerGpuPreRollbackDiagnostics } from "./docker-gpu-pre-rollback-diagnostics";
import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import { adaptDockerGpuRouteForPatch } from "./docker-gpu-route-patch-adapter";
import { isDockerDesktopWslRuntime } from "./docker-gpu-sandbox-create-plan";
import {
  createDockerSandboxRecreator,
  type RecreateGpuPatchFn,
  type RecreateStartupPatchFn,
} from "./docker-startup-command-sandbox-create";
import {
  applyDockerManagedStartupRootRequest,
  type DockerManagedStartupTransaction,
  getDockerManagedStartupFailureTransaction,
} from "./managed-startup/docker-root-apply";
import { finalizeDockerManagedStartupSharedState } from "./managed-startup/docker-shared-state";
import type { ManagedStartupRootApplyRequest } from "./managed-startup/root-apply";
import { findOpenShellDockerSandboxContainerIds } from "./openshell-docker-sandbox-containers";
import type { SandboxCreateRuntimePatch } from "./sandbox-create-runtime/types";

export type {
  DockerGpuRoutePlan,
  SelectedDockerGpuRoute,
} from "./docker-gpu-route";
export {
  isDockerDesktopWslRuntime,
  resetIsDockerDesktopWslRuntimeCache,
  resolveDockerGpuSandboxCreatePlan,
} from "./docker-gpu-sandbox-create-plan";

type DockerGpuSandboxCreateDeps = Pick<
  DockerGpuPatchDeps,
  "runOpenshell" | "runCaptureOpenshell" | "sleep" | "dockerCapture" | "dockerRun" | "dockerStop"
>;

type WaitSupervisorFn = typeof waitForOpenShellSupervisorReconnect;
type FindContainerIdsFn = typeof findOpenShellDockerSandboxContainerIds;
type FinalizeBackupFn = typeof finalizeDockerGpuPatchBackup;
type CapturePreRollbackDiagnosticsFn = typeof captureDockerGpuPreRollbackDiagnostics;
type FinalizeManagedStartupSharedStateFn = typeof finalizeDockerManagedStartupSharedState;
type ApplyManagedStartupRootRequestFn = typeof applyDockerManagedStartupRootRequest;
// Loosen the override return type from `never` to `void` so tests can pass a
// plain `vi.fn()` mock. Production wires `printDockerGpuPatchFailureAndExit`
// which has return type `never`; that is assignable to `void`.
type PatchFailureExitFn = (
  sandboxName: string,
  error: unknown,
  deps: Parameters<typeof printDockerGpuPatchFailureAndExit>[2],
) => void;

export type DockerGpuSandboxCreatePatchOptions = {
  route: SelectedDockerGpuRoute;
  persistStartupCommand?: boolean;
  managedStartupRootApplyRequest?: ManagedStartupRootApplyRequest | null;
  sandboxName: string;
  gpuDevice?: string | null;
  openshellSandboxCommand?: readonly string[] | null;
  requiredUlimits?: Parameters<RecreateStartupPatchFn>[0]["requiredUlimits"];
  timeoutSecs: number;
  backend?: DockerGpuPatchBackend;
  /**
   * Whether the host is Docker Desktop WSL. Defaults to the cached
   * `isDockerDesktopWslRuntime()` probe. When true, the GPU patch skips the CDI
   * mode (unusable on this runtime) and uses `--gpus` instead (#5512).
   */
  dockerDesktopWsl?: boolean;
  deps: DockerGpuSandboxCreateDeps;
  /**
   * Test seams. The production composition uses the canonical
   * `docker-gpu-patch`/`docker-gpu-patch-finalize` exports; tests substitute
   * lightweight mocks to drive the deferred-finalize sequence without
   * standing up the full Docker recreate plumbing.
   */
  overrides?: {
    findContainerIds?: FindContainerIdsFn;
    recreatePatch?: RecreateGpuPatchFn;
    recreateStartupPatch?: RecreateStartupPatchFn;
    applyManagedStartupRootRequest?: ApplyManagedStartupRootRequestFn;
    waitForSupervisor?: WaitSupervisorFn;
    finalizeBackup?: FinalizeBackupFn;
    finalizeManagedStartupSharedState?: FinalizeManagedStartupSharedStateFn;
    capturePreRollbackDiagnostics?: CapturePreRollbackDiagnosticsFn;
    onPatchFailureExit?: PatchFailureExitFn;
  };
};

export interface DockerGpuSandboxCreateHooks {
  selectedMode(): DockerGpuPatchMode | null;
  printReadinessFailureIfEnabled(): void;
  verifyGpuOrExit(
    verifyDirectSandboxGpu: (sandboxName: string) => SandboxGpuProofResult,
  ): SandboxGpuProofResult;
}

export type DockerGpuSandboxCreatePatch = SandboxCreateRuntimePatch & DockerGpuSandboxCreateHooks;

export function createDockerGpuSandboxCreatePatch(
  options: DockerGpuSandboxCreatePatchOptions,
): DockerGpuSandboxCreatePatch {
  const routeAdapter = adaptDockerGpuRouteForPatch(options.route);
  let result: DockerGpuPatchResult | null = null;
  let managedStartupTransaction: DockerManagedStartupTransaction | null = null;
  let managedStartupApplied = false;
  let patchError: unknown = null;
  let needsSupervisorWait = false;
  let managedStartupFinalized = false;

  const findContainerIds =
    options.overrides?.findContainerIds ?? findOpenShellDockerSandboxContainerIds;
  const recreatePatch = options.overrides?.recreatePatch ?? recreateOpenShellDockerSandboxWithGpu;
  const recreateStartupPatch = options.overrides?.recreateStartupPatch;
  const applyManagedStartupRootRequest =
    options.overrides?.applyManagedStartupRootRequest ?? applyDockerManagedStartupRootRequest;
  const waitForSupervisor =
    options.overrides?.waitForSupervisor ?? waitForOpenShellSupervisorReconnect;
  const finalizeBackup = options.overrides?.finalizeBackup ?? finalizeDockerGpuPatchBackup;
  const finalizeManagedStartupSharedState =
    options.overrides?.finalizeManagedStartupSharedState ?? finalizeDockerManagedStartupSharedState;
  const captureFailedClone =
    options.overrides?.capturePreRollbackDiagnostics ?? captureDockerGpuPreRollbackDiagnostics;
  const onPatchFailureExit =
    options.overrides?.onPatchFailureExit ?? printDockerGpuPatchFailureAndExit;

  const applyOptions = {
    sandboxName: options.sandboxName,
    gpuDevice: options.gpuDevice,
    openshellSandboxCommand: options.openshellSandboxCommand ?? null,
    requiredUlimits: options.requiredUlimits ?? null,
    timeoutSecs: options.timeoutSecs,
    backend: options.backend,
    dockerDesktopWsl: options.dockerDesktopWsl ?? isDockerDesktopWslRuntime(),
  };
  const recreationEnabled = routeAdapter.enabled || options.persistStartupCommand === true;
  const managedStartupEnabled = options.managedStartupRootApplyRequest != null;
  const patchEnabled = recreationEnabled || managedStartupEnabled;
  const patchTarget = routeAdapter.enabled
    ? managedStartupEnabled
      ? "NVIDIA GPU access and managed startup"
      : "NVIDIA GPU access"
    : recreationEnabled
      ? managedStartupEnabled
        ? "restart-safe startup and managed startup"
        : "restart-safe startup"
      : "managed startup";
  const recreateSelectedPatch = createDockerSandboxRecreator({
    gpuEnabled: routeAdapter.enabled,
    gpuOptions: applyOptions,
    startupCommand: options.openshellSandboxCommand,
    requiredUlimits: options.requiredUlimits,
    recreateGpu: recreatePatch,
    recreateStartup: recreateStartupPatch,
  });

  const applyManagedStartupToContainer = (containerId: string): void => {
    const request = options.managedStartupRootApplyRequest;
    if (!request) return;
    console.log(
      `  Applying the ${request.agent} managed startup profile to exact container ${containerId.slice(0, 12)}...`,
    );
    managedStartupTransaction = applyManagedStartupRootRequest(
      { containerId, request },
      { dockerCapture: options.deps.dockerCapture },
    );
    managedStartupApplied = true;
    console.log(
      managedStartupTransaction
        ? `  ✓ Managed startup profile applied for ${request.agent}`
        : `  ✓ Managed startup profile was already complete for ${request.agent}`,
    );
  };

  const applyPatch = (deps: DockerGpuPatchDeps): void => {
    let targetContainerId: string;
    if (recreationEnabled) {
      result = recreateSelectedPatch(false, deps);
      needsSupervisorWait = true;
      targetContainerId = result.newContainerId;
      console.log(`  ✓ Docker container mode selected: ${result.mode.label}`);
    } else {
      const containerIds = findContainerIds(options.sandboxName);
      if (containerIds.length !== 1) {
        throw new Error(
          `Managed startup requires exactly one OpenShell Docker container; found ${String(
            containerIds.length,
          )}.`,
        );
      }
      targetContainerId = containerIds[0] as string;
    }
    applyManagedStartupToContainer(targetContainerId);
  };

  const rollbackAfterFailure = (): Error | null => {
    if (managedStartupFinalized || (!managedStartupTransaction && !result)) return null;
    try {
      if (managedStartupTransaction) {
        finalizeManagedStartupSharedState(
          {
            transaction: managedStartupTransaction,
            patchResult: result,
            supervisorReady: false,
          },
          options.deps,
        );
      }
      if (result) finalizeBackup({ result, supervisorReady: false }, options.deps);
      managedStartupFinalized = true;
      needsSupervisorWait = false;
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };

  const reportPatchErrorAndExit = (): void => {
    if (!patchError) return;
    const rollbackError = rollbackAfterFailure();
    if (rollbackError) {
      patchError = new Error(
        `${patchError instanceof Error ? patchError.message : String(patchError)}; managed startup rollback failed: ${rollbackError.message}`,
      );
    }
    onPatchFailureExit(options.sandboxName, patchError, {
      runCaptureOpenshell: options.deps.runCaptureOpenshell,
      dockerCapture: options.deps.dockerCapture,
      additionalSummaryLines: routeAdapter.additionalSummaryLines,
    });
  };

  return {
    revalidateBeforeMutation() {},

    maybeApplyDuringCreate() {
      if (!patchEnabled || result || managedStartupApplied || patchError) return;
      const containerIds = findContainerIds(options.sandboxName);
      if (containerIds.length === 0) return;
      if (containerIds.length !== 1) {
        patchError = new Error(
          `Managed startup observed ${String(containerIds.length)} matching Docker containers; refusing an ambiguous root application.`,
        );
        return;
      }
      console.log(
        `  OpenShell Docker container detected; applying ${patchTarget} before readiness wait...`,
      );
      try {
        applyPatch({
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          sleep: options.deps.sleep,
        });
      } catch (error) {
        managedStartupTransaction ??= getDockerManagedStartupFailureTransaction(error);
        patchError = error;
      }
    },

    createFailureMessage() {
      if (!patchError) return null;
      return routeAdapter.enabled
        ? "Docker GPU patch failed while OpenShell sandbox create was still waiting."
        : managedStartupEnabled
          ? "Docker managed startup failed while OpenShell sandbox create was still waiting."
          : "Docker startup-command patch failed while OpenShell sandbox create was still waiting.";
    },

    exitOnPatchError() {
      reportPatchErrorAndExit();
    },

    rollbackManagedStartupAfterCreateFailure() {
      const rollbackError = rollbackAfterFailure();
      if (!rollbackError) return;
      onPatchFailureExit(options.sandboxName, rollbackError, {
        runCaptureOpenshell: options.deps.runCaptureOpenshell,
        dockerCapture: options.deps.dockerCapture,
        additionalSummaryLines: routeAdapter.additionalSummaryLines,
      });
    },

    ensureApplied() {
      if (!patchEnabled || result || managedStartupApplied) return;
      console.log(`  Applying ${patchTarget} to the OpenShell Docker sandbox...`);
      try {
        applyPatch(options.deps);
      } catch (error) {
        managedStartupTransaction ??= getDockerManagedStartupFailureTransaction(error);
        patchError = error;
        reportPatchErrorAndExit();
      }
    },

    waitForSupervisorReconnectIfNeeded() {
      if (!needsSupervisorWait || managedStartupFinalized) return;
      const supervisorReconnectTimeoutSecs = getDockerGpuSupervisorReconnectTimeoutSecs(
        options.timeoutSecs,
      );
      console.log(
        `  Waiting for OpenShell supervisor to reconnect to the recreated container (up to ${supervisorReconnectTimeoutSecs}s)...`,
      );
      const supervisorReady = waitForSupervisor(
        options.sandboxName,
        supervisorReconnectTimeoutSecs,
        {
          runOpenshell: options.deps.runOpenshell,
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          sleep: options.deps.sleep,
        },
      );
      if (supervisorReady) {
        // Reconnect is necessary but not sufficient for cutover. Keep both the
        // managed shared-state receipt and recreation backup until the caller
        // accepts authoritative Ready and any required GPU proof.
        needsSupervisorWait = false;
        return;
      }
      if (!supervisorReady && result) {
        try {
          captureFailedClone(options.sandboxName, result, options.deps);
        } catch (error) {
          console.warn(
            `  ⚠ Could not capture the failed GPU container before rollback: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      let managedSharedStateOutcome = {
        supervisorReady: false,
        failure: null as Error | null,
      };
      if (managedStartupTransaction) {
        try {
          managedSharedStateOutcome = finalizeManagedStartupSharedState(
            {
              transaction: managedStartupTransaction,
              patchResult: result,
              supervisorReady: false,
            },
            options.deps,
          );
        } catch (error) {
          onPatchFailureExit(options.sandboxName, error, {
            runCaptureOpenshell: options.deps.runCaptureOpenshell,
            dockerCapture: options.deps.dockerCapture,
            additionalSummaryLines: routeAdapter.additionalSummaryLines,
            context: {
              sandboxName: options.sandboxName,
              oldContainerId: result?.oldContainerId ?? null,
              newContainerId: result?.newContainerId ?? managedStartupTransaction.containerId,
              backupContainerName: result?.backupContainerName ?? null,
              selectedMode: result?.mode ?? null,
              rolledBack: false,
            },
          });
          return;
        }
      }
      const finalizeOutcome = result
        ? finalizeBackup(
            { result, supervisorReady: managedSharedStateOutcome.supervisorReady },
            options.deps,
          )
        : null;
      managedStartupFinalized = true;
      needsSupervisorWait = false;
      const failureMessage = (() => {
        if (managedSharedStateOutcome.failure) {
          if (!result) {
            return `${managedSharedStateOutcome.failure.message}; failed container removed after shared-state rollback.`;
          }
          return finalizeOutcome?.rolledBack
            ? `${managedSharedStateOutcome.failure.message}; pre-patch sandbox restored.`
            : `${managedSharedStateOutcome.failure.message}; container rollback failed and pre-patch sandbox was NOT restored.`;
        }
        if (!finalizeOutcome) {
          return "OpenShell supervisor did not reconnect to the recreated container.";
        }
        return finalizeOutcome.rolledBack
          ? "OpenShell supervisor did not reconnect to the recreated container; pre-patch sandbox restored."
          : "OpenShell supervisor did not reconnect to the recreated container and rollback failed; pre-patch sandbox was NOT restored.";
      })();
      onPatchFailureExit(options.sandboxName, new Error(failureMessage), {
        runCaptureOpenshell: options.deps.runCaptureOpenshell,
        dockerCapture: options.deps.dockerCapture,
        additionalSummaryLines: routeAdapter.additionalSummaryLines,
        context: {
          sandboxName: options.sandboxName,
          oldContainerId: result?.oldContainerId,
          newContainerId: result?.newContainerId,
          backupContainerName: result?.backupContainerName,
          selectedMode: result?.mode ?? null,
          rolledBack: finalizeOutcome?.rolledBack ?? false,
        },
      });
    },

    commitAfterReady() {
      if (managedStartupFinalized || (!managedStartupTransaction && !result)) return;
      if (needsSupervisorWait) {
        const error = new Error(
          "Managed startup cannot commit before the recreated OpenShell supervisor reconnects.",
        );
        const rollbackError = rollbackAfterFailure();
        onPatchFailureExit(
          options.sandboxName,
          rollbackError
            ? new Error(`${error.message} Rollback failed: ${rollbackError.message}`)
            : error,
          {
            runCaptureOpenshell: options.deps.runCaptureOpenshell,
            dockerCapture: options.deps.dockerCapture,
            additionalSummaryLines: routeAdapter.additionalSummaryLines,
          },
        );
        return;
      }
      let managedSharedStateOutcome = {
        supervisorReady: true,
        failure: null as Error | null,
      };
      if (managedStartupTransaction) {
        try {
          managedSharedStateOutcome = finalizeManagedStartupSharedState(
            {
              transaction: managedStartupTransaction,
              patchResult: result,
              supervisorReady: true,
            },
            options.deps,
          );
        } catch (error) {
          onPatchFailureExit(options.sandboxName, error, {
            runCaptureOpenshell: options.deps.runCaptureOpenshell,
            dockerCapture: options.deps.dockerCapture,
            additionalSummaryLines: routeAdapter.additionalSummaryLines,
            context: {
              sandboxName: options.sandboxName,
              oldContainerId: result?.oldContainerId ?? null,
              newContainerId: result?.newContainerId ?? managedStartupTransaction.containerId,
              backupContainerName: result?.backupContainerName ?? null,
              selectedMode: result?.mode ?? null,
              rolledBack: false,
            },
          });
          return;
        }
      }
      const finalizeOutcome = result
        ? finalizeBackup(
            { result, supervisorReady: managedSharedStateOutcome.supervisorReady },
            options.deps,
          )
        : null;
      managedStartupFinalized = true;
      if (managedSharedStateOutcome.supervisorReady) {
        if (finalizeOutcome && !finalizeOutcome.backupRemoved) {
          onPatchFailureExit(
            options.sandboxName,
            new Error(
              "Managed startup passed Ready, but the recreated backup container could not be removed.",
            ),
            {
              runCaptureOpenshell: options.deps.runCaptureOpenshell,
              dockerCapture: options.deps.dockerCapture,
              additionalSummaryLines: routeAdapter.additionalSummaryLines,
              context: {
                sandboxName: options.sandboxName,
                oldContainerId: result?.oldContainerId,
                newContainerId: result?.newContainerId,
                backupContainerName: result?.backupContainerName,
                selectedMode: result?.mode ?? null,
                rolledBack: false,
              },
            },
          );
        }
        return;
      }
      const failureMessage = (() => {
        if (!result) {
          return `${managedSharedStateOutcome.failure?.message ?? "Managed shared-state commit failed"}; failed container removed after shared-state rollback.`;
        }
        return finalizeOutcome?.rolledBack
          ? `${managedSharedStateOutcome.failure?.message ?? "Managed shared-state commit failed"}; pre-patch sandbox restored.`
          : `${managedSharedStateOutcome.failure?.message ?? "Managed shared-state commit failed"}; container rollback failed and pre-patch sandbox was NOT restored.`;
      })();
      onPatchFailureExit(options.sandboxName, new Error(failureMessage), {
        runCaptureOpenshell: options.deps.runCaptureOpenshell,
        dockerCapture: options.deps.dockerCapture,
        additionalSummaryLines: routeAdapter.additionalSummaryLines,
        context: {
          sandboxName: options.sandboxName,
          oldContainerId: result?.oldContainerId,
          newContainerId: result?.newContainerId,
          backupContainerName: result?.backupContainerName,
          selectedMode: result?.mode ?? null,
          rolledBack: finalizeOutcome?.rolledBack ?? false,
        },
      });
    },

    selectedMode() {
      return result?.mode ?? null;
    },

    printReadinessFailureIfEnabled() {
      if (!routeAdapter.enabled) return;
      printDockerGpuReadinessFailure(options.sandboxName, result?.mode ?? null, {
        runCaptureOpenshell: options.deps.runCaptureOpenshell,
        dockerCapture: options.deps.dockerCapture,
        context: buildFailureContext(options.sandboxName, result),
        additionalSummaryLines: routeAdapter.additionalSummaryLines,
      });
    },

    verifyGpuOrExit(verifyDirectSandboxGpu) {
      // Before issuing GPU proof commands through `openshell sandbox exec`,
      // confirm the sandbox is still in a live phase. A sandbox that
      // transitioned to Error after the readiness wait succeeded (e.g. the
      // patched GPU container crashed mid-startup) would make the proof step
      // fail with an exec error that looks like an `nvidia-smi` failure —
      // masking the real cause. When that happens, surface the patched-
      // container/Error-phase classification instead of running the proof
      // (#4316).
      const sandboxName = options.sandboxName;
      const failureContext = buildFailureContext(sandboxName, result);
      if (routeAdapter.enabled && options.deps.runCaptureOpenshell) {
        const list = options.deps.runCaptureOpenshell(["sandbox", "list"], {
          ignoreError: true,
        });
        const phase = getSandboxFailurePhase(list, sandboxName);
        if (phase) {
          console.error("");
          console.error(`  Skipping GPU proof: sandbox '${sandboxName}' is in ${phase} phase.`);
          printDockerGpuProofFailure(
            sandboxName,
            new Error(
              `Sandbox '${sandboxName}' entered ${phase} phase after readiness; GPU proof skipped.`,
            ),
            result?.mode ?? null,
            {
              runCaptureOpenshell: options.deps.runCaptureOpenshell,
              dockerCapture: options.deps.dockerCapture,
              context: failureContext,
              additionalSummaryLines: routeAdapter.additionalSummaryLines,
            },
          );
          const rollbackError = rollbackAfterFailure();
          if (rollbackError) {
            onPatchFailureExit(options.sandboxName, rollbackError, {
              runCaptureOpenshell: options.deps.runCaptureOpenshell,
              dockerCapture: options.deps.dockerCapture,
              additionalSummaryLines: routeAdapter.additionalSummaryLines,
            });
          }
          process.exit(1);
        }
      }
      try {
        const proof = verifyDirectSandboxGpu(sandboxName);
        if (proof.status === "failed") {
          const label = proof.label ? `: ${proof.label}` : "";
          const detail = proof.detail ? ` (${proof.detail})` : "";
          throw new Error(`Sandbox GPU proof returned failed status${label}${detail}`);
        }
        return proof;
      } catch (error) {
        printDockerGpuProofFailure(sandboxName, error, result?.mode ?? null, {
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          dockerCapture: options.deps.dockerCapture,
          context: routeAdapter.enabled ? failureContext : null,
          additionalSummaryLines: routeAdapter.additionalSummaryLines,
        });
        throw error;
      }
    },
  };
}

function buildFailureContext(
  sandboxName: string,
  result: DockerGpuPatchResult | null,
): DockerGpuPatchFailureContext {
  return {
    sandboxName,
    // `oldContainerId` is retained alongside `newContainerId` so the
    // before/after pair lands in `patched-container-state.json` and
    // `docker-network-summary.txt`, matching the supervisor-reconnect path.
    oldContainerId: result?.oldContainerId ?? null,
    newContainerId: result?.newContainerId ?? null,
    backupContainerName: result?.backupContainerName ?? null,
    selectedMode: result?.mode ?? null,
  };
}
