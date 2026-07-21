// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildDockerGpuMode,
  type DockerGpuPatchDeps,
  type DockerGpuPatchResult,
  recreateOpenShellDockerSandboxContainer,
} from "./docker-gpu-patch";

const STARTUP_COMMAND_MODE = buildDockerGpuMode("startup-command");

export function recreateOpenShellDockerSandboxWithStartupCommand(
  options: {
    sandboxName: string;
    timeoutSecs?: number;
    waitForSupervisor?: boolean;
    openshellSandboxCommand: readonly string[];
    requiredUlimits?: readonly import("./docker-gpu-patch-types").DockerUlimit[] | null;
    expectedOldContainerId?: string | null;
  },
  deps: DockerGpuPatchDeps = {},
): DockerGpuPatchResult {
  if (options.openshellSandboxCommand.length === 0) {
    throw new Error("OpenShell sandbox startup command is required for restart persistence.");
  }
  return recreateOpenShellDockerSandboxContainer(
    { ...options, modeOverride: STARTUP_COMMAND_MODE },
    deps,
  );
}
