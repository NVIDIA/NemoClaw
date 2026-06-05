// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  dockerRename as defaultDockerRename,
  dockerRm as defaultDockerRm,
  dockerStart as defaultDockerStart,
  dockerStop as defaultDockerStop,
} from "../adapters/docker";
import type { DockerGpuPatchDeps, DockerGpuPatchResult } from "./docker-gpu-patch";

const DOCKER_GPU_PATCH_TIMEOUT_MS = 30_000;

type DockerRunResult = {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

type DockerRunOptions = Record<string, unknown>;

type DockerContainerFn = (containerName: string, opts?: DockerRunOptions) => DockerRunResult;
type DockerRenameFn = (
  oldContainerName: string,
  newContainerName: string,
  opts?: DockerRunOptions,
) => DockerRunResult;

type ResolvedRollbackDeps = {
  dockerStop: DockerContainerFn;
  dockerRm: DockerContainerFn;
  dockerRename: DockerRenameFn;
  dockerStart: DockerContainerFn;
};

function isZeroStatus(result: DockerRunResult | null | undefined): boolean {
  return Number(result?.status ?? 0) === 0;
}

function resolveRollbackDeps(deps: DockerGpuPatchDeps): ResolvedRollbackDeps {
  return {
    dockerStop: deps.dockerStop ?? defaultDockerStop,
    dockerRm: deps.dockerRm ?? defaultDockerRm,
    dockerRename: deps.dockerRename ?? defaultDockerRename,
    dockerStart: deps.dockerStart ?? defaultDockerStart,
  };
}

export function rollbackToBackupContainer(
  refs: { newContainerId: string; backupContainerName: string; originalName: string },
  deps: ResolvedRollbackDeps,
): boolean {
  const containerOpts = {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  };
  deps.dockerStop(refs.newContainerId, containerOpts);
  deps.dockerRm(refs.newContainerId, containerOpts);
  const restored = deps.dockerRename(
    refs.backupContainerName,
    refs.originalName,
    containerOpts,
  );
  if (!isZeroStatus(restored)) return false;
  const started = deps.dockerStart(refs.originalName, containerOpts);
  return isZeroStatus(started);
}

export type DockerGpuPatchFinalizeOptions = {
  result: DockerGpuPatchResult;
  supervisorReady: boolean;
};

export type DockerGpuPatchFinalizeOutcome = {
  backupRemoved: boolean;
  rolledBack: boolean;
};

export function finalizeDockerGpuPatchBackup(
  options: DockerGpuPatchFinalizeOptions,
  deps: DockerGpuPatchDeps = {},
): DockerGpuPatchFinalizeOutcome {
  const resolved = resolveRollbackDeps(deps);
  const containerOpts = {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  };
  if (options.result.backupRemoved) {
    return { backupRemoved: true, rolledBack: false };
  }
  if (options.supervisorReady) {
    resolved.dockerRm(options.result.backupContainerName, containerOpts);
    return { backupRemoved: true, rolledBack: false };
  }
  const rolledBack = rollbackToBackupContainer(
    {
      newContainerId: options.result.newContainerId,
      backupContainerName: options.result.backupContainerName,
      originalName: options.result.originalName,
    },
    resolved,
  );
  return { backupRemoved: false, rolledBack };
}

export function rollbackPatchToBackup(
  refs: { newContainerId: string; backupContainerName: string; originalName: string },
  deps: DockerGpuPatchDeps,
): boolean {
  return rollbackToBackupContainer(refs, resolveRollbackDeps(deps));
}
