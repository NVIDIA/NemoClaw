// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
import { getSandboxFailurePhase } from "../state/gateway";

type DockerGpuSandboxCreateDeps = Pick<
  DockerGpuPatchDeps,
  "runOpenshell" | "runCaptureOpenshell" | "sleep" | "dockerCapture"
>;

type DockerGpuSandboxCreatePatchOptions = {
  enabled: boolean;
  sandboxName: string;
  gpuDevice?: string | null;
  openshellSandboxCommand?: readonly string[] | null;
  timeoutSecs: number;
  backend?: DockerGpuPatchBackend;
  deps: DockerGpuSandboxCreateDeps;
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
   * onboarding flow surfaces the right failure cause (#4316).
   */
  verifyGpuOrExit: (verifyDirectSandboxGpu: (sandboxName: string) => void) => void;
};

export function createDockerGpuSandboxCreatePatch(
  options: DockerGpuSandboxCreatePatchOptions,
): DockerGpuSandboxCreatePatch {
  let result: DockerGpuPatchResult | null = null;
  let patchError: unknown = null;
  let needsSupervisorWait = false;

  const applyOptions = {
    sandboxName: options.sandboxName,
    gpuDevice: options.gpuDevice,
    openshellSandboxCommand: options.openshellSandboxCommand ?? null,
    timeoutSecs: options.timeoutSecs,
    backend: options.backend,
  };

  return {
    maybeApplyDuringCreate() {
      if (!options.enabled || result || patchError) return;
      const containerIds = findOpenShellDockerSandboxContainerIds(options.sandboxName);
      if (containerIds.length === 0) return;
      console.log(
        "  OpenShell Docker container detected; recreating it with NVIDIA GPU access before readiness wait...",
      );
      try {
        result = recreateOpenShellDockerSandboxWithGpu(
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
      printDockerGpuPatchFailureAndExit(options.sandboxName, patchError, {
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
      const supervisorReady = waitForOpenShellSupervisorReconnect(
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
      if (supervisorReady) return;
      printDockerGpuPatchFailureAndExit(
        options.sandboxName,
        new Error("OpenShell supervisor did not reconnect to the GPU-enabled container."),
        {
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
          dockerCapture: options.deps.dockerCapture,
          context: {
            sandboxName: options.sandboxName,
            oldContainerId: result?.oldContainerId,
            newContainerId: result?.newContainerId,
            backupContainerName: result?.backupContainerName,
            selectedMode: result?.mode ?? null,
          },
        },
      );
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
        verifyDirectSandboxGpu(sandboxName);
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
  options: { dockerDriverGateway: boolean; log?: (message: string) => void },
): boolean {
  const enabled = shouldApplyDockerGpuPatch(config, {
    dockerDriverGateway: options.dockerDriverGateway,
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
  options: { dockerDriverGateway: boolean },
): DockerGpuSandboxCreatePlan {
  const useDockerGpuPatch = shouldUseDockerGpuPatchForCreate(config, options);
  const logMessage = config.sandboxGpuEnabled
    ? useDockerGpuPatch
      ? config.hostGpuPlatform === "jetson"
        ? "  Jetson sandbox GPU enabled; using NVIDIA Container Runtime instead of CDI/--gpus."
        : "  Docker-driver GPU patch active; allowing /proc writes required by Docker GPU initialization."
      : "  Direct sandbox GPU enabled; allowing OpenShell GPU policy enrichment."
    : null;
  return { useDockerGpuPatch, logMessage };
}
