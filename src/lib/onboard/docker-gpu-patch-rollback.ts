// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  dockerRename as defaultDockerRename,
  dockerRm as defaultDockerRm,
  dockerStart as defaultDockerStart,
  dockerStop as defaultDockerStop,
} from "../adapters/docker";
import type { DockerGpuPatchDeps } from "./docker-gpu-patch";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";

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

export type ResolvedDockerGpuPatchRollbackDeps = {
  dockerStop: DockerContainerFn;
  dockerRm: DockerContainerFn;
  dockerRename: DockerRenameFn;
  dockerStart: DockerContainerFn;
};

function isZeroStatus(result: DockerRunResult | null | undefined): boolean {
  // spawnSync reports `status: null` when the process times out or cannot be
  // spawned. Cleanup and rollback are safety gates, so only an explicit zero
  // exit status is success.
  return result?.status === 0;
}

export function resolveDockerGpuPatchRollbackDeps(
  deps: DockerGpuPatchDeps,
): ResolvedDockerGpuPatchRollbackDeps {
  return {
    dockerStop: deps.dockerStop ?? defaultDockerStop,
    dockerRm: deps.dockerRm ?? defaultDockerRm,
    dockerRename: deps.dockerRename ?? defaultDockerRename,
    dockerStart: deps.dockerStart ?? defaultDockerStart,
  };
}

export function rollbackToBackupContainer(
  refs: { newContainerId: string; backupContainerName: string; originalName: string },
  deps: ResolvedDockerGpuPatchRollbackDeps,
): boolean {
  const containerOpts = {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  };
  deps.dockerStop(refs.newContainerId, containerOpts);
  deps.dockerRm(refs.newContainerId, containerOpts);
  const restored = deps.dockerRename(refs.backupContainerName, refs.originalName, containerOpts);
  if (!isZeroStatus(restored)) return false;
  const started = deps.dockerStart(refs.originalName, containerOpts);
  return isZeroStatus(started);
}

/** Restore the original sandbox after `docker run` fails during GPU recreation. */
export function restoreDockerGpuPatchBackupAfterRecreateFailure(
  refs: { newContainerId: string; backupContainerName: string; originalName: string },
  deps: DockerGpuPatchDeps = {},
): boolean {
  return rollbackToBackupContainer(refs, resolveDockerGpuPatchRollbackDeps(deps));
}
