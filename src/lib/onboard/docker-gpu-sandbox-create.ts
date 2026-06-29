// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandboxFailurePhase } from "../state/gateway";
import type { SandboxGpuProofResult } from "../state/registry";
import type {
  DockerGpuPatchBackend,
  DockerGpuPatchDeps,
  DockerGpuPatchFailureContext,
  DockerGpuPatchMode,
  DockerGpuPatchResult,
} from "./docker-gpu-patch";
import {
  applyDockerGpuPatchOrExit,
  findOpenShellDockerSandboxContainerIds,
  getDockerGpuSupervisorReconnectTimeoutSecs,
  printDockerGpuPatchFailureAndExit,
  printDockerGpuProofFailure,
  printDockerGpuReadinessFailure,
  recreateOpenShellDockerSandboxWithGpu,
  shouldApplyDockerGpuPatch,
  waitForOpenShellSupervisorReconnect,
} from "./docker-gpu-patch";
import { finalizeDockerGpuPatchBackup } from "./docker-gpu-patch-finalize";
import { detectWslDockerDesktopStatus } from "./wsl-docker-desktop-gpu";

let cachedDockerDesktopWslRuntime: boolean | null = null;

export function isDockerDesktopWslRuntime(): boolean {
  if (cachedDockerDesktopWslRuntime === null) {
    cachedDockerDesktopWslRuntime = detectWslDockerDesktopStatus({}) === "docker-desktop";
  }
  return cachedDockerDesktopWslRuntime;
}

export function resetIsDockerDesktopWslRuntimeCache(): void {
  cachedDockerDesktopWslRuntime = null;
}

type DockerGpuSandboxCreateDeps = Pick<
  DockerGpuPatchDeps,
  "runOpenshell" | "runCaptureOpenshell" | "sleep" | "dockerCapture"
>;

type RecreatePatchFn = typeof recreateOpenShellDockerSandboxWithGpu;
type WaitSupervisorFn = typeof waitForOpenShellSupervisorReconnect;
type FindContainerIdsFn = typeof findOpenShellDockerSandboxContainerIds;
type FinalizeBackupFn = typeof finalizeDockerGpuPatchBackup;
// Loosen the override return type from `never` to `void` so tests can pass a
// plain `vi.fn()` mock. Production wires `printDockerGpuPatchFailureAndExit`
// which has return type `never`; that is assignable to `void`.
type PatchFailureExitFn = (
  sandboxName: string,
  error: unknown,
  deps: Parameters<typeof printDockerGpuPatchFailureAndExit>[2],
) => void;

type DockerGpuSandboxCreatePatchOptions = {
  enabled: boolean;
  sandboxName: string;
  gpuDevice?: string | null;
  openshellSandboxCommand?: readonly string[] | null;
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
    recreatePatch?: RecreatePatchFn;
    waitForSupervisor?: WaitSupervisorFn;
    finalizeBackup?: FinalizeBackupFn;
    onPatchFailureExit?: PatchFailureExitFn;
  };
};

type DockerGpuSandboxConfig = {
  sandboxGpuEnabled: boolean;
  sandboxGpuDevice?: string | null;
  hostGpuPlatform?: string | null;
};

type DockerGpuSandboxCreatePlan = {
  useDockerGpuPatch: boolean;
  logMessage: string | null;
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
  let result: DockerGpuPatchResult | null = null;
  let patchError: unknown = null;
  let needsSupervisorWait = false;

  const findContainerIds =
    options.overrides?.findContainerIds ?? findOpenShellDockerSandboxContainerIds;
  const recreatePatch = options.overrides?.recreatePatch ?? recreateOpenShellDockerSandboxWithGpu;
  const waitForSupervisor =
    options.overrides?.waitForSupervisor ?? waitForOpenShellSupervisorReconnect;
  const finalizeBackup = options.overrides?.finalizeBackup ?? finalizeDockerGpuPatchBackup;
  const onPatchFailureExit =
    options.overrides?.onPatchFailureExit ?? printDockerGpuPatchFailureAndExit;

  const applyOptions = {
    sandboxName: options.sandboxName,
    gpuDevice: options.gpuDevice,
    openshellSandboxCommand: options.openshellSandboxCommand ?? null,
    timeoutSecs: options.timeoutSecs,
    backend: options.backend,
    dockerDesktopWsl: options.dockerDesktopWsl ?? isDockerDesktopWslRuntime(),
  };

  return {
    maybeApplyDuringCreate() {
      if (!options.enabled || result || patchError) return;
      const containerIds = findContainerIds(options.sandboxName);
      if (containerIds.length === 0) return;
      console.log(
        "  OpenShell Docker container detected; recreating it with NVIDIA GPU access before readiness wait...",
      );
      try {
        result = recreatePatch(
          { ...applyOptions, waitForSupervisor: false },
          { runCaptureOpenshell: options.deps.runCaptureOpenshell, sleep: options.deps.sleep },
        );
        needsSupervisorWait = true;
        console.log(`  ✓ Docker GPU mode selected: ${result.mode.label}`);
      } catch (error) {
        patchError = error;
      }
    },

    createFailureMessage() {
      if (!patchError) return null;
      return "Docker GPU patch failed while OpenShell sandbox create was still waiting.";
    },

    exitOnPatchError() {
      if (!patchError) return;
      onPatchFailureExit(options.sandboxName, patchError, {
        runCaptureOpenshell: options.deps.runCaptureOpenshell,
        dockerCapture: options.deps.dockerCapture,
      });
    },

    ensureApplied() {
      if (!options.enabled || result) return;
      result = applyDockerGpuPatchOrExit(applyOptions, options.deps);
    },

    waitForSupervisorReconnectIfNeeded() {
      if (!needsSupervisorWait) return;
      const supervisorReconnectTimeoutSecs = getDockerGpuSupervisorReconnectTimeoutSecs(
        options.timeoutSecs,
      );
      console.log(
        `  Waiting for OpenShell supervisor to reconnect to the GPU-enabled container (up to ${supervisorReconnectTimeoutSecs}s)...`,
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
      const finalizeOutcome = result
        ? finalizeBackup({ result, supervisorReady }, options.deps)
        : null;
      if (supervisorReady) return;
      const failureMessage = (() => {
        if (!finalizeOutcome) {
          return "OpenShell supervisor did not reconnect to the GPU-enabled container.";
        }
        return finalizeOutcome.rolledBack
          ? "OpenShell supervisor did not reconnect to the GPU-enabled container; pre-patch sandbox restored."
          : "OpenShell supervisor did not reconnect to the GPU-enabled container and rollback failed; pre-patch sandbox was NOT restored.";
      })();
      onPatchFailureExit(options.sandboxName, new Error(failureMessage), {
        runCaptureOpenshell: options.deps.runCaptureOpenshell,
        dockerCapture: options.deps.dockerCapture,
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
      if (!options.enabled) return;
      printDockerGpuReadinessFailure(options.sandboxName, result?.mode ?? null, {
        runCaptureOpenshell: options.deps.runCaptureOpenshell,
        dockerCapture: options.deps.dockerCapture,
        context: buildFailureContext(options.sandboxName, result),
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
      if (options.enabled && options.deps.runCaptureOpenshell) {
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
            },
          );
          process.exit(1);
        }
      }
      try {
        return verifyDirectSandboxGpu(sandboxName);
      } catch (error) {
        printDockerGpuProofFailure(sandboxName, error, result?.mode ?? null, {
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          dockerCapture: options.deps.dockerCapture,
          context: options.enabled ? failureContext : null,
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

export function shouldUseDockerGpuPatchForCreate(
  config: DockerGpuSandboxConfig,
  options: {
    dockerDriverGateway: boolean;
    dockerDesktopWsl?: boolean;
    log?: (message: string) => void;
  },
): boolean {
  const enabled = shouldApplyDockerGpuPatch(config, {
    dockerDriverGateway: options.dockerDriverGateway,
    dockerDesktopWsl: options.dockerDesktopWsl,
    log: options.log,
  });
  if (enabled) {
    options.log?.(
      config.hostGpuPlatform === "jetson"
        ? "  Jetson Docker GPU patch active; creating sandbox first, then recreating the Docker container with NVIDIA runtime GPU access."
        : "  Docker-driver GPU patch active; creating sandbox first, then recreating the Docker container with GPU access.",
    );
  }
  return enabled;
}

export function resolveDockerGpuSandboxCreatePlan(
  config: DockerGpuSandboxConfig,
  options: {
    dockerDriverGateway: boolean;
    dockerDesktopWsl?: boolean;
    detectDockerDesktopWsl?: () => boolean;
  },
): DockerGpuSandboxCreatePlan {
  const dockerDesktopWsl =
    options.dockerDesktopWsl ?? (options.detectDockerDesktopWsl ?? isDockerDesktopWslRuntime)();
  const useDockerGpuPatch = shouldUseDockerGpuPatchForCreate(config, {
    dockerDriverGateway: options.dockerDriverGateway,
    dockerDesktopWsl,
  });
  const logMessage = config.sandboxGpuEnabled
    ? useDockerGpuPatch
      ? config.hostGpuPlatform === "jetson"
        ? "  Jetson sandbox GPU enabled; using NVIDIA Container Runtime instead of CDI/--gpus."
        : "  Docker-driver GPU patch active; allowing /proc writes required by Docker GPU initialization."
      : "  Direct sandbox GPU enabled; allowing OpenShell GPU policy enrichment."
    : null;
  return { useDockerGpuPatch, logMessage };
}
