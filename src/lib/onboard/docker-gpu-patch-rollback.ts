// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  dockerRename as defaultDockerRename,
  dockerRm as defaultDockerRm,
  dockerRun as defaultDockerRun,
  dockerStart as defaultDockerStart,
  dockerStop as defaultDockerStop,
} from "../adapters/docker";
import { hasZeroDockerExitStatus } from "./docker-command-result";
import { fullDockerContainerId } from "./docker-gpu-patch-clone";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import type { DockerGpuPatchDeps } from "./docker-gpu-patch-types";

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
type DockerRunFn = (args: readonly string[], opts?: DockerRunOptions) => DockerRunResult;

const REPLACEMENT_PRESENCE_ATTEMPTS = 3;
const REPLACEMENT_PRESENCE_RETRY_SECONDS = 0.5;

function sleepBeforeReplacementPresenceRetry(seconds: number): void {
  if (seconds <= 0 || !Number.isFinite(seconds)) return;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, seconds * 1000);
}

export type DockerGpuPatchRollbackOutcome = {
  rolledBack: boolean;
  replacementStopConfirmed: boolean;
  replacementRemovalConfirmed: boolean;
  replacementPresence: "absent" | "present" | "unknown";
};

export type ResolvedDockerGpuPatchRollbackDeps = {
  dockerRun: DockerRunFn;
  dockerStop: DockerContainerFn;
  dockerRm: DockerContainerFn;
  dockerRename: DockerRenameFn;
  dockerStart: DockerContainerFn;
  sleep: (seconds: number) => void;
};

export function resolveDockerGpuPatchRollbackDeps(
  deps: DockerGpuPatchDeps,
): ResolvedDockerGpuPatchRollbackDeps {
  return {
    dockerRun: deps.dockerRun ?? defaultDockerRun,
    dockerStop: deps.dockerStop ?? defaultDockerStop,
    dockerRm: deps.dockerRm ?? defaultDockerRm,
    dockerRename: deps.dockerRename ?? defaultDockerRename,
    dockerStart: deps.dockerStart ?? defaultDockerStart,
    sleep: deps.sleep ?? sleepBeforeReplacementPresenceRetry,
  };
}

function outputText(value: string | Buffer | null | undefined): string {
  return value ? value.toString() : "";
}

function observeReplacementPresence(
  containerId: string,
  deps: ResolvedDockerGpuPatchRollbackDeps,
  options: DockerRunOptions,
): DockerGpuPatchRollbackOutcome["replacementPresence"] {
  const exactId = fullDockerContainerId(containerId);
  if (!exactId) return "unknown";
  for (let attempt = 0; attempt < REPLACEMENT_PRESENCE_ATTEMPTS; attempt += 1) {
    const result = deps.dockerRun(
      ["ps", "-a", "--no-trunc", "--filter", `id=${exactId}`, "--format", "{{.ID}}"],
      options,
    );
    if (hasZeroDockerExitStatus(result)) {
      const ids = outputText(result.stdout)
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean);
      return ids.some((id) => fullDockerContainerId(id) === exactId) ? "present" : "absent";
    }
    if (attempt + 1 < REPLACEMENT_PRESENCE_ATTEMPTS) {
      deps.sleep(REPLACEMENT_PRESENCE_RETRY_SECONDS);
    }
  }
  return "unknown";
}

export function rollbackToBackupContainer(
  refs: { newContainerId: string; backupContainerName: string; originalName: string },
  deps: ResolvedDockerGpuPatchRollbackDeps,
): DockerGpuPatchRollbackOutcome {
  const containerOpts = {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  };
  const replacementStopConfirmed = hasZeroDockerExitStatus(
    deps.dockerStop(refs.newContainerId, containerOpts),
  );
  const replacementRemovalConfirmed = hasZeroDockerExitStatus(
    deps.dockerRm(refs.newContainerId, containerOpts),
  );
  const replacementPresence = replacementRemovalConfirmed
    ? "absent"
    : observeReplacementPresence(refs.newContainerId, deps, containerOpts);
  const restored = deps.dockerRename(refs.backupContainerName, refs.originalName, containerOpts);
  const rolledBack = hasZeroDockerExitStatus(restored)
    ? hasZeroDockerExitStatus(deps.dockerStart(refs.originalName, containerOpts))
    : false;
  return {
    rolledBack,
    replacementStopConfirmed,
    replacementRemovalConfirmed,
    replacementPresence,
  };
}

/** Restore the original sandbox after `docker run` fails during GPU recreation. */
export function restoreDockerGpuPatchBackupAfterRecreateFailure(
  refs: { newContainerId: string; backupContainerName: string; originalName: string },
  deps: DockerGpuPatchDeps = {},
): boolean {
  return rollbackToBackupContainer(refs, resolveDockerGpuPatchRollbackDeps(deps)).rolledBack;
}
