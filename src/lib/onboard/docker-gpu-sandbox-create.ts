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
  DockerGpuPatchFailureClassification,
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
import { findOpenShellDockerSandboxContainerIds } from "./openshell-docker-sandbox-containers";

export type { DockerGpuRoutePlan, SelectedDockerGpuRoute } from "./docker-gpu-route";
export {
  isDockerDesktopWslRuntime,
  resetIsDockerDesktopWslRuntimeCache,
  resolveProfileGpuCreatePlan,
  resolveDockerGpuSandboxCreatePlan,
} from "./docker-gpu-sandbox-create-plan";

type DockerGpuSandboxCreateDeps = Pick<
  DockerGpuPatchDeps,
  | "runOpenshell"
  | "runCaptureOpenshell"
  | "sleep"
  | "dockerCapture"
  | "dockerRun"
  | "dockerStop"
  | "dockerRm"
  | "dockerRename"
  | "dockerStart"
  | "dockerLogs"
  | "homedir"
  | "now"
>;

type WaitSupervisorFn = typeof waitForOpenShellSupervisorReconnect;
type FindContainerIdsFn = typeof findOpenShellDockerSandboxContainerIds;
type FinalizeBackupFn = typeof finalizeDockerGpuPatchBackup;
type CapturePreRollbackDiagnosticsFn = typeof captureDockerGpuPreRollbackDiagnostics;
// Loosen the override return type from `never` to `void` so tests can pass a
// plain `vi.fn()` mock. Production wires `printDockerGpuPatchFailureAndExit`
// which has return type `never`; that is assignable to `void`.
type PatchFailureExitFn = (
  sandboxName: string,
  error: unknown,
  deps: Parameters<typeof printDockerGpuPatchFailureAndExit>[2],
) => void;

type DockerGpuSandboxCreatePatchOptions = {
  route: SelectedDockerGpuRoute;
  persistStartupCommand?: boolean;
  /**
   * A managed bootstrap owns the one permitted recreation after Ready. Keep
   * route diagnostics/proof active without running the legacy recreator.
   */
  externalRecreation?: boolean;
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
    waitForSupervisor?: WaitSupervisorFn;
    finalizeBackup?: FinalizeBackupFn;
    capturePreRollbackDiagnostics?: CapturePreRollbackDiagnosticsFn;
    onPatchFailureExit?: PatchFailureExitFn;
  };
};

export interface DockerManagedBootstrapDeferredCutover {
  readonly selectedMode: DockerGpuPatchMode;
  readonly failureContext: DockerGpuPatchFailureContext;
  rollback(): Promise<void>;
  commit(): Promise<void>;
}

export type DockerGpuSandboxCreatePatch = {
  maybeApplyDuringCreate: () => void;
  /** Full Docker container ID owned by the transaction, or null until it records a replacement. */
  replacementRuntimeId: () => string | null;
  createFailureMessage: () => string | null;
  exitOnPatchError: () => Promise<void>;
  attachManagedBootstrapCutover: (cutover: DockerManagedBootstrapDeferredCutover) => void;
  rollbackManagedStartupAfterCreateFailure: () => Promise<void>;
  ensureApplied: () => Promise<void>;
  waitForSupervisorReconnectIfNeeded: () => void;
  /**
   * Commit an attached managed cutover or remove a legacy recreation backup.
   * Call only after authoritative Ready and the required GPU and applicable
   * local-inference checks pass.
   */
  commitAfterReady: () => Promise<void>;
  selectedMode: () => DockerGpuPatchMode | null;
  /**
   * Print the Docker GPU readiness-failure block (including the Error-phase
   * classification + patched container State diagnostics) when the
   * post-create readiness wait times out. No-op when the patch is disabled.
   */
  printReadinessFailureIfEnabled: () => void;
  /**
   * Run the GPU proof while distinguishing "sandbox in terminal phase" from
   * "proof failed inside a live sandbox". Awaits rollback and throws after
   * printing diagnostics so the onboarding flow can select the terminal exit
   * status without racing the rollback (#4316). Returns the CUDA-usability
   * proof result on success so callers can persist it (#4231).
   */
  verifyGpuOrExit: (
    verifyDirectSandboxGpu: (sandboxName: string) => SandboxGpuProofResult,
  ) => Promise<SandboxGpuProofResult>;
};

export function createDockerGpuSandboxCreatePatch(
  options: DockerGpuSandboxCreatePatchOptions,
): DockerGpuSandboxCreatePatch {
  const routeAdapter = adaptDockerGpuRouteForPatch(options.route);
  let result: DockerGpuPatchResult | null = null;
  let managedBootstrapCutover: DockerManagedBootstrapDeferredCutover | null = null;
  let patchError: unknown = null;
  let needsSupervisorWait = false;
  let cutoverFinalized = false;
  let cutoverFinalization: Promise<void> | null = null;
  let cutoverFinalizationOutcome: "commit" | "rollback" | null = null;
  let cutoverFinalizationFailure: Error | null = null;

  const findContainerIds =
    options.overrides?.findContainerIds ?? findOpenShellDockerSandboxContainerIds;
  const recreatePatch = options.overrides?.recreatePatch ?? recreateOpenShellDockerSandboxWithGpu;
  const recreateStartupPatch = options.overrides?.recreateStartupPatch;
  const waitForSupervisor =
    options.overrides?.waitForSupervisor ?? waitForOpenShellSupervisorReconnect;
  const finalizeBackup = options.overrides?.finalizeBackup ?? finalizeDockerGpuPatchBackup;
  const captureFailedClone =
    options.overrides?.capturePreRollbackDiagnostics ?? captureDockerGpuPreRollbackDiagnostics;
  const onPatchFailureExit =
    options.overrides?.onPatchFailureExit ?? printDockerGpuPatchFailureAndExit;
  const failureDiagnosticDeps = {
    runCaptureOpenshell: options.deps.runCaptureOpenshell,
    dockerCapture: options.deps.dockerCapture,
    dockerLogs: options.deps.dockerLogs,
    homedir: options.deps.homedir,
    now: options.deps.now,
  };

  const applyOptions = {
    sandboxName: options.sandboxName,
    gpuDevice: options.gpuDevice,
    openshellSandboxCommand: options.openshellSandboxCommand ?? null,
    requiredUlimits: options.requiredUlimits ?? null,
    timeoutSecs: options.timeoutSecs,
    backend: options.backend,
    dockerDesktopWsl: options.dockerDesktopWsl ?? isDockerDesktopWslRuntime(),
  };
  const recreationEnabled =
    options.externalRecreation !== true &&
    (routeAdapter.enabled || options.persistStartupCommand === true);
  const patchEnabled = recreationEnabled;
  const patchTarget = routeAdapter.enabled ? "NVIDIA GPU access" : "restart-safe startup";
  const recreateSelectedPatch = createDockerSandboxRecreator({
    gpuEnabled: routeAdapter.enabled,
    gpuOptions: applyOptions,
    startupCommand: options.openshellSandboxCommand,
    requiredUlimits: options.requiredUlimits,
    recreateGpu: recreatePatch,
    recreateStartup: recreateStartupPatch,
  });

  const applyPatch = (deps: DockerGpuPatchDeps): void => {
    if (!recreationEnabled) return;
    result = recreateSelectedPatch(false, deps);
    needsSupervisorWait = true;
    console.log(`  ✓ Docker container mode selected: ${result.mode.label}`);
  };

  const rollbackAfterFailure = async (): Promise<Error | null> => {
    if (cutoverFinalized || (!managedBootstrapCutover && !result)) return null;
    if (cutoverFinalization) {
      try {
        if (cutoverFinalizationOutcome !== "rollback") {
          throw new Error("Managed startup rollback raced an in-progress commit finalization.");
        }
        await cutoverFinalization;
        return null;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    }
    const finalization = (async () => {
      await managedBootstrapCutover?.rollback();
      const finalizeOutcome = result
        ? finalizeBackup({ result, supervisorReady: false }, options.deps)
        : null;
      cutoverFinalized = true;
      needsSupervisorWait = false;
      if (finalizeOutcome && !finalizeOutcome.rolledBack) {
        throw new Error(
          "Docker container rollback failed; the pre-patch container was not restored.",
        );
      }
    })();
    cutoverFinalization = finalization;
    cutoverFinalizationOutcome = "rollback";
    try {
      await finalization;
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      if (!cutoverFinalized) {
        cutoverFinalization = null;
        cutoverFinalizationOutcome = null;
      }
    }
  };

  const reportPatchErrorAndExit = async (): Promise<void> => {
    if (!patchError) return;
    const rollbackError = await rollbackAfterFailure();
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
  const selectedMode = (): DockerGpuPatchMode | null =>
    managedBootstrapCutover?.selectedMode ?? result?.mode ?? null;
  const failureContext = (): DockerGpuPatchFailureContext =>
    managedBootstrapCutover?.failureContext ?? buildFailureContext(options.sandboxName, result);

  return {
    maybeApplyDuringCreate() {
      if (!patchEnabled || result || patchError) return;
      const containerIds = findContainerIds(options.sandboxName);
      if (containerIds.length === 0) return;
      if (containerIds.length !== 1) {
        patchError = new Error(
          `Docker recreation observed ${String(containerIds.length)} matching containers; refusing an ambiguous replacement.`,
        );
        return;
      }
      console.log(
        `  OpenShell Docker container detected; recreating it with ${patchTarget} before readiness wait...`,
      );
      try {
        applyPatch({
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          sleep: options.deps.sleep,
        });
      } catch (error) {
        patchError = error;
      }
    },

    replacementRuntimeId() {
      return result?.newContainerId ?? null;
    },

    createFailureMessage() {
      if (!patchError) return null;
      return routeAdapter.enabled
        ? "Docker GPU patch failed while OpenShell sandbox create was still waiting."
        : "Docker startup-command patch failed while OpenShell sandbox create was still waiting.";
    },

    async exitOnPatchError() {
      await reportPatchErrorAndExit();
    },

    attachManagedBootstrapCutover(cutover) {
      if (managedBootstrapCutover || result || cutoverFinalized) {
        throw new Error("Managed bootstrap cutover may be attached exactly once.");
      }
      managedBootstrapCutover = cutover;
    },

    async rollbackManagedStartupAfterCreateFailure() {
      const rollbackError = await rollbackAfterFailure();
      if (!rollbackError) return;
      onPatchFailureExit(options.sandboxName, rollbackError, {
        ...failureDiagnosticDeps,
        additionalSummaryLines: routeAdapter.additionalSummaryLines,
        context: {
          ...failureContext(),
          rolledBack: false,
        },
      });
    },

    async ensureApplied() {
      if (!patchEnabled || result) return;
      console.log(`  Recreating OpenShell Docker sandbox container with ${patchTarget}...`);
      try {
        applyPatch(options.deps);
      } catch (error) {
        patchError = error;
        await reportPatchErrorAndExit();
      }
    },

    waitForSupervisorReconnectIfNeeded() {
      if (!needsSupervisorWait || cutoverFinalized) return;
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
        // Reconnect completes the legacy recreation check. Keep its rollback
        // backup until the caller accepts authoritative Ready and the required
        // GPU checks.
        needsSupervisorWait = false;
        return;
      }
      // Keep the pre-rollback verdict: it is computed while the replacement
      // container is still inspectable, so it is the only classification that
      // can name the exit code. The failure printer cannot rely on that
      // replacement remaining inspectable after rollback (#7996).
      let preRollbackClassification: DockerGpuPatchFailureClassification | null = null;
      if (result) {
        try {
          preRollbackClassification =
            captureFailedClone(options.sandboxName, result, options.deps)?.classification ?? null;
        } catch (error) {
          console.warn(
            `  ⚠ Could not capture the failed GPU container before rollback: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const finalizeOutcome = result
        ? finalizeBackup({ result, supervisorReady: false }, options.deps)
        : null;
      cutoverFinalized = true;
      needsSupervisorWait = false;
      const failureMessage = finalizeOutcome?.rolledBack
        ? "OpenShell supervisor did not reconnect to the recreated container; pre-patch sandbox restored."
        : "OpenShell supervisor did not reconnect to the recreated container and rollback failed; pre-patch sandbox was NOT restored.";
      onPatchFailureExit(options.sandboxName, new Error(failureMessage), {
        runCaptureOpenshell: options.deps.runCaptureOpenshell,
        dockerCapture: options.deps.dockerCapture,
        dockerLogs: options.deps.dockerLogs,
        homedir: options.deps.homedir,
        now: options.deps.now,
        additionalSummaryLines: routeAdapter.additionalSummaryLines,
        preRollbackClassification,
        context: {
          sandboxName: options.sandboxName,
          oldContainerId: result?.oldContainerId,
          newContainerId: result?.newContainerId,
          backupContainerName: result?.backupContainerName,
          selectedMode: result?.mode ?? null,
          rolledBack: finalizeOutcome?.rolledBack ?? false,
          replacementStopConfirmed: finalizeOutcome?.replacementStopConfirmed,
          replacementRemovalConfirmed: finalizeOutcome?.replacementRemovalConfirmed,
          replacementPresence: finalizeOutcome?.replacementPresence,
        },
      });
    },

    async commitAfterReady() {
      if (cutoverFinalizationFailure) throw cutoverFinalizationFailure;
      if (cutoverFinalized || (!managedBootstrapCutover && !result)) return;
      if (needsSupervisorWait) {
        const error = new Error(
          "Managed startup cannot commit before the recreated OpenShell supervisor reconnects.",
        );
        const rollbackError = await rollbackAfterFailure();
        const failure = rollbackError
          ? new Error(`${error.message} Rollback failed: ${rollbackError.message}`)
          : error;
        cutoverFinalizationFailure = failure;
        onPatchFailureExit(options.sandboxName, failure, {
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          dockerCapture: options.deps.dockerCapture,
          additionalSummaryLines: routeAdapter.additionalSummaryLines,
        });
        throw failure;
      }
      if (cutoverFinalization) {
        if (cutoverFinalizationOutcome !== "commit") {
          throw new Error("Managed startup commit raced an in-progress rollback finalization.");
        }
        await cutoverFinalization;
        return;
      }
      const finalization = (async () => {
        if (managedBootstrapCutover) {
          try {
            await managedBootstrapCutover.commit();
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            let rollbackError: Error | null = null;
            try {
              await managedBootstrapCutover.rollback();
              cutoverFinalized = true;
              needsSupervisorWait = false;
            } catch (rollbackFailure) {
              rollbackError =
                rollbackFailure instanceof Error
                  ? rollbackFailure
                  : new Error(String(rollbackFailure));
              (
                failure as Error & { managedBootstrapRollbackError?: unknown }
              ).managedBootstrapRollbackError = rollbackError;
            }
            cutoverFinalizationFailure = failure;
            onPatchFailureExit(options.sandboxName, failure, {
              runCaptureOpenshell: options.deps.runCaptureOpenshell,
              dockerCapture: options.deps.dockerCapture,
              additionalSummaryLines: routeAdapter.additionalSummaryLines,
              context: {
                ...failureContext(),
                rolledBack: rollbackError === null,
              },
            });
            throw failure;
          }
        }
        const supervisorReconnectTimeoutSecs = getDockerGpuSupervisorReconnectTimeoutSecs(
          options.timeoutSecs,
        );
        const finalHandoffDeadlineMs = Date.now() + supervisorReconnectTimeoutSecs * 1000;
        const finalizeOutcome = result
          ? finalizeBackup(
              {
                result,
                supervisorReady: true,
                sandboxName: options.sandboxName,
                lifecycleReleaseTimeoutSecs: supervisorReconnectTimeoutSecs,
              },
              options.deps,
            )
          : null;
        cutoverFinalized = true;
        if (!finalizeOutcome) return;
        if (finalizeOutcome.backupRemoved && finalizeOutcome.replacementRestarted === undefined) {
          return;
        }
        if (
          finalizeOutcome.backupRemoved &&
          finalizeOutcome.replacementRestarted &&
          finalizeOutcome.lifecycleReleaseObserved === true
        ) {
          const remainingReconnectTimeoutSecs = Math.max(
            0,
            Math.ceil((finalHandoffDeadlineMs - Date.now()) / 1000),
          );
          console.log(
            `  Waiting for OpenShell supervisor to confirm the final container handoff (up to ${remainingReconnectTimeoutSecs}s)...`,
          );
          if (
            remainingReconnectTimeoutSecs > 0 &&
            waitForSupervisor(options.sandboxName, remainingReconnectTimeoutSecs, {
              runOpenshell: options.deps.runOpenshell,
              runCaptureOpenshell: options.deps.runCaptureOpenshell,
              sleep: options.deps.sleep,
            })
          ) {
            return;
          }
        }
        const failure = new Error(
          "Managed startup passed Ready, but its final runtime handoff did not converge.",
        );
        cutoverFinalizationFailure = failure;
        onPatchFailureExit(options.sandboxName, failure, {
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          dockerCapture: options.deps.dockerCapture,
          additionalSummaryLines: routeAdapter.additionalSummaryLines,
          context: failureContext(),
        });
        throw failure;
      })();
      cutoverFinalization = finalization;
      cutoverFinalizationOutcome = "commit";
      try {
        await finalization;
      } finally {
        if (!cutoverFinalized) {
          cutoverFinalization = null;
          cutoverFinalizationOutcome = null;
        }
      }
    },

    selectedMode() {
      return selectedMode();
    },

    printReadinessFailureIfEnabled() {
      if (!routeAdapter.enabled) return;
      printDockerGpuReadinessFailure(options.sandboxName, selectedMode(), {
        runCaptureOpenshell: options.deps.runCaptureOpenshell,
        dockerCapture: options.deps.dockerCapture,
        context: failureContext(),
        additionalSummaryLines: routeAdapter.additionalSummaryLines,
      });
    },

    async verifyGpuOrExit(verifyDirectSandboxGpu) {
      // Before issuing GPU proof commands through `openshell sandbox exec`,
      // confirm the sandbox is still in a live phase. A sandbox that
      // transitioned to Error after the readiness wait succeeded (e.g. the
      // patched GPU container crashed mid-startup) would make the proof step
      // fail with an exec error that looks like an `nvidia-smi` failure —
      // masking the real cause. When that happens, surface the patched-
      // container/Error-phase classification instead of running the proof
      // (#4316).
      const sandboxName = options.sandboxName;
      const currentFailureContext = failureContext();
      if (routeAdapter.enabled && options.deps.runCaptureOpenshell) {
        const list = options.deps.runCaptureOpenshell(["sandbox", "list"], {
          ignoreError: true,
        });
        const phase = getSandboxFailurePhase(list, sandboxName);
        if (phase) {
          console.error("");
          console.error(`  Skipping GPU proof: sandbox '${sandboxName}' is in ${phase} phase.`);
          const failure = new Error(
            `Sandbox '${sandboxName}' entered ${phase} phase after readiness; GPU proof skipped.`,
          );
          printDockerGpuProofFailure(sandboxName, failure, selectedMode(), {
            runCaptureOpenshell: options.deps.runCaptureOpenshell,
            dockerCapture: options.deps.dockerCapture,
            context: currentFailureContext,
            additionalSummaryLines: routeAdapter.additionalSummaryLines,
          });
          const rollbackError = await rollbackAfterFailure();
          if (rollbackError) {
            console.error(`  ${rollbackError.message}`);
            (
              failure as Error & { managedBootstrapRollbackError?: unknown }
            ).managedBootstrapRollbackError = rollbackError;
          }
          throw failure;
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
        const failure = error instanceof Error ? error : new Error(String(error));
        printDockerGpuProofFailure(sandboxName, failure, selectedMode(), {
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          dockerCapture: options.deps.dockerCapture,
          context: routeAdapter.enabled ? currentFailureContext : null,
          additionalSummaryLines: routeAdapter.additionalSummaryLines,
        });
        const rollbackError = await rollbackAfterFailure();
        if (rollbackError) {
          console.error(`  ${rollbackError.message}`);
          (
            failure as Error & { managedBootstrapRollbackError?: unknown }
          ).managedBootstrapRollbackError = rollbackError;
        }
        throw failure;
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
