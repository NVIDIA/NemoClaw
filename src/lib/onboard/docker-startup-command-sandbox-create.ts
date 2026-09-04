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

type DockerSandboxRecreator = {
  (waitForSupervisor: false, deps: DockerGpuPatchDeps): DockerGpuPatchResult;
  (waitForSupervisor: true, deps: DockerGpuPatchDeps): Promise<DockerGpuPatchResult>;
};

export function createDockerSandboxRecreator(options: {
  gpuEnabled: boolean;
  gpuOptions: Parameters<RecreateGpuPatchFn>[0];
  startupCommand: readonly string[] | null | undefined;
  requiredUlimits?: Parameters<RecreateStartupPatchFn>[0]["requiredUlimits"];
  recreateGpu?: RecreateGpuPatchFn;
  recreateStartup?: RecreateStartupPatchFn;
}): DockerSandboxRecreator {
  const recreateGpu = options.recreateGpu ?? recreateOpenShellDockerSandboxWithGpu;
  const recreateStartup =
    options.recreateStartup ?? recreateOpenShellDockerSandboxWithStartupCommand;
  return ((waitForSupervisor: boolean, deps: DockerGpuPatchDeps) => {
    if (options.gpuEnabled) {
      return waitForSupervisor
        ? recreateGpu({ ...options.gpuOptions, waitForSupervisor: true }, deps)
        : recreateGpu({ ...options.gpuOptions, waitForSupervisor: false }, deps);
    }
    const startupOptions = {
      sandboxName: options.gpuOptions.sandboxName,
      openshellSandboxCommand: options.startupCommand || [],
      requiredUlimits: options.requiredUlimits,
      timeoutSecs: options.gpuOptions.timeoutSecs,
    };
    return waitForSupervisor
      ? recreateStartup({ ...startupOptions, waitForSupervisor: true }, deps)
      : recreateStartup({ ...startupOptions, waitForSupervisor: false }, deps);
  }) as DockerSandboxRecreator;
}
