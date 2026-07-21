// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type DockerGpuPatchDeps,
  type DockerGpuPatchResult,
  recreateOpenShellDockerSandboxWithGpu,
} from "./docker-gpu-patch";
import { recreateOpenShellDockerSandboxWithStartupCommand } from "./docker-startup-command-patch";

export type RecreateGpuPatchFn = typeof recreateOpenShellDockerSandboxWithGpu;
export type RecreateStartupPatchFn = typeof recreateOpenShellDockerSandboxWithStartupCommand;

export function createDockerSandboxRecreator(options: {
  gpuEnabled: boolean;
  gpuOptions: Parameters<RecreateGpuPatchFn>[0];
  startupCommand: readonly string[] | null | undefined;
  requiredUlimits?: Parameters<RecreateStartupPatchFn>[0]["requiredUlimits"];
  recreateGpu?: RecreateGpuPatchFn;
  recreateStartup?: RecreateStartupPatchFn;
}): (waitForSupervisor: boolean, deps: DockerGpuPatchDeps) => DockerGpuPatchResult {
  const recreateGpu = options.recreateGpu ?? recreateOpenShellDockerSandboxWithGpu;
  const recreateStartup =
    options.recreateStartup ?? recreateOpenShellDockerSandboxWithStartupCommand;
  return (waitForSupervisor, deps) => {
    if (options.gpuEnabled) {
      return recreateGpu({ ...options.gpuOptions, waitForSupervisor }, deps);
    }
    return recreateStartup(
      {
        sandboxName: options.gpuOptions.sandboxName,
        openshellSandboxCommand: options.startupCommand || [],
        requiredUlimits: options.requiredUlimits,
        timeoutSecs: options.gpuOptions.timeoutSecs,
        waitForSupervisor,
      },
      deps,
    );
  };
}
