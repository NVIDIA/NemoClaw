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
import { findOpenShellDockerSandboxContainerIds } from "./openshell-docker-sandbox-containers";

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
  "runOpenshell" | "runCaptureOpenshell" | "sleep" | "dockerCapture"
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

export type DockerGpuSandboxCreatePatch = {
  maybeApplyDuringCreate: () => void;
  createFailureMessage: () => string | null;
  exitOnPatchError: () => void;
  ensureApplied: () => void;
  waitForSupervisorReconnectIfNeeded: () => void;
  selectedMode: () => DockerGpuPatchMode | null;
  /**
   * Print the Docker GPU readiness-failure block (including the Error-phase
   * classification + patched container State diagnostics) when the
   * post-create readiness wait times out. No-op when the patch is disabled.
   */
  printReadinessFailureIfEnabled: () => void;
  /**
   * Run the GPU proof while distinguishing "sandbox in terminal phase" from
   * "proof failed inside a live sandbox". Calls `process.exit(1)` for the
   * former and rethrows after printing diagnostics for the latter so the
   * onboarding flow surfaces the right failure cause (#4316). Returns the
   * CUDA-usability proof result on success so callers can persist it (#4231).
   */
  verifyGpuOrExit: (
    verifyDirectSandboxGpu: (sandboxName: string) => SandboxGpuProofResult,
  ) => SandboxGpuProofResult;
};

export function createDockerGpuSandboxCreatePatch(
  options: DockerGpuSandboxCreatePatchOptions,
): DockerGpuSandboxCreatePatch {
  const routeAdapter = adaptDockerGpuRouteForPatch(options.route);
  let result: DockerGpuPatchResult | null = null;
  let patchError: unknown = null;
  let needsSupervisorWait = false;

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

  const applyOptions = {
    sandboxName: options.sandboxName,
    gpuDevice: options.gpuDevice,
    openshellSandboxCommand: options.openshellSandboxCommand ?? null,
    requiredUlimits: options.requiredUlimits ?? null,
    timeoutSecs: options.timeoutSecs,
    backend: options.backend,
    dockerDesktopWsl: options.dockerDesktopWsl ?? isDockerDesktopWslRuntime(),
  };
  const patchEnabled = routeAdapter.enabled || options.persistStartupCommand === true;
  const patchTarget = routeAdapter.enabled ? "NVIDIA GPU access" : "restart-safe startup";
  const recreateSelectedPatch = createDockerSandboxRecreator({
    gpuEnabled: routeAdapter.enabled,
    gpuOptions: applyOptions,
    startupCommand: options.openshellSandboxCommand,
    requiredUlimits: options.requiredUlimits,
    recreateGpu: recreatePatch,
    recreateStartup: recreateStartupPatch,
  });

  return {
    maybeApplyDuringCreate() {
      if (!patchEnabled || result || patchError) return;
      const containerIds = findContainerIds(options.sandboxName);
      if (containerIds.length === 0) return;
      console.log(
        `  OpenShell Docker container detected; recreating it with ${patchTarget} before readiness wait...`,
      );
      try {
        result = recreateSelectedPatch(false, {
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          sleep: options.deps.sleep,
        });
        needsSupervisorWait = true;
        console.log(`  ✓ Docker container mode selected: ${result.mode.label}`);
      } catch (error) {
        patchError = error;
      }
    },

    createFailureMessage() {
      if (!patchError) return null;
      return routeAdapter.enabled
        ? "Docker GPU patch failed while OpenShell sandbox create was still waiting."
        : "Docker startup-command patch failed while OpenShell sandbox create was still waiting.";
    },

    exitOnPatchError() {
      if (!patchError) return;
      onPatchFailureExit(options.sandboxName, patchError, {
        runCaptureOpenshell: options.deps.runCaptureOpenshell,
        dockerCapture: options.deps.dockerCapture,
        additionalSummaryLines: routeAdapter.additionalSummaryLines,
      });
    },

    ensureApplied() {
      if (!patchEnabled || result) return;
      console.log(`  Recreating OpenShell Docker sandbox container with ${patchTarget}...`);
      try {
        result = recreateSelectedPatch(false, options.deps);
        needsSupervisorWait = true;
        console.log(`  ✓ Docker container mode selected: ${result.mode.label}`);
      } catch (error) {
        onPatchFailureExit(options.sandboxName, error, {
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          dockerCapture: options.deps.dockerCapture,
          additionalSummaryLines: routeAdapter.additionalSummaryLines,
        });
      }
    },

    waitForSupervisorReconnectIfNeeded() {
      if (!needsSupervisorWait) return;
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
          // Pass `runCaptureOpenshell` so the supervisor-reconnect wait can
          // short-circuit on a terminal sandbox phase instead of burning
          // the full reconnect timeout window when the patched container
          // crashed on startup (#4316).
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          sleep: options.deps.sleep,
        },
      );
      if (!supervisorReady && result) {
        try {
          captureFailedClone(options.sandboxName, result, options.deps);
        } catch (error) {
          console.warn(
            `  ⚠ Could not capture the failed GPU container before rollback: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const finalizeOutcome = result
        ? finalizeBackup({ result, supervisorReady }, options.deps)
        : null;
      if (supervisorReady) {
        if (finalizeOutcome && !finalizeOutcome.backupRemoved) {
          onPatchFailureExit(
            options.sandboxName,
            new Error(
              "OpenShell supervisor reconnected, but the recreated backup container could not be removed.",
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
