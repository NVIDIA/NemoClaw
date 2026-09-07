// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildDockerGpuMode,
  type DockerGpuPatchDeps,
  type DockerGpuPatchResult,
  recreateOpenShellDockerSandboxContainer,
} from "./docker-gpu-patch";

const STARTUP_COMMAND_MODE = buildDockerGpuMode("startup-command");

type RecreateStartupCommandOptions = {
  sandboxName: string;
  timeoutSecs?: number;
  waitForSupervisor?: boolean;
  openshellSandboxCommand: readonly string[];
  requiredUlimits?: readonly import("./docker-gpu-patch-types").DockerUlimit[] | null;
  expectedOldContainerId?: string | null;
};

export function recreateOpenShellDockerSandboxWithStartupCommand(
  options: RecreateStartupCommandOptions & { waitForSupervisor: false },
  deps?: DockerGpuPatchDeps,
): DockerGpuPatchResult;
export function recreateOpenShellDockerSandboxWithStartupCommand(
  options: RecreateStartupCommandOptions & { waitForSupervisor?: true },
  deps?: DockerGpuPatchDeps,
): Promise<DockerGpuPatchResult>;
export function recreateOpenShellDockerSandboxWithStartupCommand(
  options: RecreateStartupCommandOptions,
  deps?: DockerGpuPatchDeps,
): DockerGpuPatchResult | Promise<DockerGpuPatchResult>;
export function recreateOpenShellDockerSandboxWithStartupCommand(
  options: RecreateStartupCommandOptions,
  deps: DockerGpuPatchDeps = {},
): DockerGpuPatchResult | Promise<DockerGpuPatchResult> {
  if (options.openshellSandboxCommand.length === 0) {
    throw new Error("OpenShell sandbox startup command is required for restart persistence.");
  }
  return options.waitForSupervisor === false
    ? recreateOpenShellDockerSandboxContainer(
        { ...options, waitForSupervisor: false, modeOverride: STARTUP_COMMAND_MODE },
        deps,
      )
    : recreateOpenShellDockerSandboxContainer(
        { ...options, waitForSupervisor: true, modeOverride: STARTUP_COMMAND_MODE },
        deps,
      );
}
