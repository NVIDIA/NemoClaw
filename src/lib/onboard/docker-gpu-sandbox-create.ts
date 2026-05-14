// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  DockerGpuPatchDeps,
  DockerGpuPatchMode,
  DockerGpuPatchResult,
} from "./docker-gpu-patch";
import {
  applyDockerGpuPatchOrExit,
  findOpenShellDockerSandboxContainerIds,
  getDockerGpuSupervisorReconnectTimeoutSecs,
  printDockerGpuPatchFailureAndExit,
  recreateOpenShellDockerSandboxWithGpu,
  shouldApplyDockerGpuPatch,
  waitForOpenShellSupervisorReconnect,
} from "./docker-gpu-patch";

type DockerGpuSandboxCreateDeps = Pick<
  DockerGpuPatchDeps,
  "runOpenshell" | "runCaptureOpenshell" | "sleep"
>;

type DockerGpuSandboxCreatePatchOptions = {
  enabled: boolean;
  sandboxName: string;
  gpuDevice?: string | null;
  timeoutSecs: number;
  deps: DockerGpuSandboxCreateDeps;
};

type DockerGpuSandboxConfig = {
  sandboxGpuEnabled: boolean;
  sandboxGpuDevice?: string | null;
};

export type DockerGpuSandboxCreatePatch = {
  maybeApplyDuringCreate: () => void;
  createFailureMessage: () => string | null;
  exitOnPatchError: () => void;
  ensureApplied: () => void;
  waitForSupervisorReconnectIfNeeded: () => void;
  selectedMode: () => DockerGpuPatchMode | null;
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
    timeoutSecs: options.timeoutSecs,
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
        { runOpenshell: options.deps.runOpenshell, sleep: options.deps.sleep },
      );
      if (supervisorReady) return;
      printDockerGpuPatchFailureAndExit(
        options.sandboxName,
        new Error("OpenShell supervisor did not reconnect to the GPU-enabled container."),
        {
          runCaptureOpenshell: options.deps.runCaptureOpenshell,
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
      "  Docker-driver GPU patch active; creating sandbox first, then recreating the Docker container with GPU access.",
    );
  }
  return enabled;
}
