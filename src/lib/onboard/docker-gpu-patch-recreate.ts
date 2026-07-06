// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  dockerCapture,
  dockerRename,
  dockerRm,
  dockerRun,
  dockerRunDetached,
  dockerStop,
} from "../adapters/docker";
import { detectSandboxFallbackDns } from "./docker-gpu-dns-fallback";
import { detectTegraDeviceGroupGids } from "./docker-gpu-jetson-groups";
import type {
  DockerContainerInspect,
  DockerGpuPatchDeps,
  DockerGpuPatchFailureContext,
  DockerGpuPatchResult,
} from "./docker-gpu-patch";
import {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuCloneRunOptions,
  dockerContainerName,
  parseDockerInspectJson,
  sameContainerId,
} from "./docker-gpu-patch-clone";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import { reconcileSupervisorReconnect } from "./docker-gpu-patch-finalize";
import { selectDockerGpuPatchMode } from "./docker-gpu-patch-mode";
import { restoreDockerGpuPatchBackupAfterRecreateFailure } from "./docker-gpu-patch-rollback";
import { waitForOpenShellSupervisorReconnect } from "./docker-gpu-supervisor-reconnect";
import { findOpenShellDockerSandboxContainerIds } from "./openshell-docker-sandbox-containers";

const DOCKER_GPU_PATCH_WAIT_SECS = 180;
const MAX_DOCKER_CONTAINER_NAME_LENGTH = 253;

type RecreateDeps = Required<
  Pick<
    DockerGpuPatchDeps,
    | "dockerCapture"
    | "dockerRun"
    | "dockerRunDetached"
    | "dockerRename"
    | "dockerRm"
    | "dockerStop"
    | "sleep"
    | "now"
    | "detectSandboxFallbackDns"
    | "detectTegraDeviceGroupGids"
  >
> &
  DockerGpuPatchDeps;

function recreateDeps(deps: DockerGpuPatchDeps): RecreateDeps {
  return {
    dockerCapture,
    dockerRun,
    dockerRunDetached,
    dockerRename,
    dockerRm,
    dockerStop,
    sleep: (seconds: number) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, seconds) * 1000);
    },
    now: () => new Date(),
    detectSandboxFallbackDns: () => detectSandboxFallbackDns(),
    detectTegraDeviceGroupGids: () => detectTegraDeviceGroupGids(),
    ...deps,
  };
}

function resultText(
  result: {
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
  } | null,
): string {
  if (!result) return "";
  return `${String(result.stderr || "")} ${String(result.stdout || "")}`.trim();
}

function isZeroStatus(result: { status?: number | null } | null | undefined): boolean {
  return result?.status === 0;
}

function inspectDockerContainer(
  containerId: string,
  deps: DockerGpuPatchDeps,
): DockerContainerInspect {
  const capture = deps.dockerCapture ?? dockerCapture;
  const output = capture(["inspect", "--type", "container", containerId], {
    ignoreError: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  });
  return parseDockerInspectJson(output);
}

function buildBackupContainerName(originalName: string, now: Date): string {
  const suffix = `-nemoclaw-gpu-backup-${String(now.getTime())}`;
  const maxOriginalLength = MAX_DOCKER_CONTAINER_NAME_LENGTH - suffix.length;
  return `${originalName.slice(0, Math.max(1, maxOriginalLength))}${suffix}`;
}

function waitForNewContainerId(
  sandboxName: string,
  oldContainerId: string,
  timeoutSecs: number,
  deps: DockerGpuPatchDeps,
): string | null {
  const d = recreateDeps(deps);
  const deadline = Date.now() + Math.max(1, timeoutSecs) * 1000;
  while (Date.now() <= deadline) {
    const replacement = findOpenShellDockerSandboxContainerIds(sandboxName, deps).find(
      (id) => !sameContainerId(id, oldContainerId),
    );
    if (replacement) return replacement;
    d.sleep(2);
  }
  return null;
}

function decoratePatchError<T extends Error>(
  error: T,
  context: DockerGpuPatchFailureContext,
): T & { dockerGpuPatch?: DockerGpuPatchFailureContext } {
  (error as T & { dockerGpuPatch?: DockerGpuPatchFailureContext }).dockerGpuPatch = context;
  return error;
}

export function getDockerGpuPatchFailureContext(
  error: unknown,
): DockerGpuPatchFailureContext | null {
  if (error && typeof error === "object" && "dockerGpuPatch" in error) {
    return (error as { dockerGpuPatch?: DockerGpuPatchFailureContext }).dockerGpuPatch || null;
  }
  return null;
}

export function recreateOpenShellDockerSandboxWithGpu(
  options: {
    sandboxName: string;
    gpuDevice?: string | null;
    timeoutSecs?: number;
    waitForSupervisor?: boolean;
    openshellSandboxCommand?: readonly string[] | null;
    backend?: "generic" | "jetson";
    dockerDesktopWsl?: boolean;
  },
  deps: DockerGpuPatchDeps = {},
): DockerGpuPatchResult {
  const d = recreateDeps(deps);
  const context: DockerGpuPatchFailureContext = {
    sandboxName: options.sandboxName,
    modeAttempts: [],
  };
  try {
    const oldContainerId = findOpenShellDockerSandboxContainerIds(options.sandboxName, deps)[0];
    if (!oldContainerId) {
      throw new Error(
        `Could not find OpenShell Docker container for sandbox '${options.sandboxName}'.`,
      );
    }
    context.oldContainerId = oldContainerId;
    const inspect = inspectDockerContainer(oldContainerId, deps);
    const image = String(inspect.Config?.Image || "").trim();
    if (!image) throw new Error("OpenShell sandbox container inspect did not include an image.");

    const selection = selectDockerGpuPatchMode(
      {
        image,
        device: options.gpuDevice,
        backend: options.backend,
        dockerDesktopWsl: options.dockerDesktopWsl,
      },
      deps,
    );
    context.modeAttempts = selection.attempts;
    context.selectedMode = selection.mode;
    if (!selection.mode) {
      throw new Error(
        options.backend === "jetson"
          ? "Docker did not accept the Jetson NVIDIA runtime GPU mode."
          : "Docker did not accept --gpus, NVIDIA runtime, or CDI GPU modes.",
      );
    }

    const originalName = dockerContainerName(inspect);
    const backupContainerName = buildBackupContainerName(originalName, d.now());
    context.backupContainerName = backupContainerName;
    const cloneOptions = buildDockerGpuCloneRunOptions(inspect);
    cloneOptions.openshellSandboxCommand = options.openshellSandboxCommand ?? null;
    const sandboxFallbackDns = d.detectSandboxFallbackDns();
    if (sandboxFallbackDns) cloneOptions.sandboxFallbackDns = sandboxFallbackDns;
    if (options.backend === "jetson") {
      const tegraGroupGids = d.detectTegraDeviceGroupGids();
      if (tegraGroupGids.length > 0) {
        cloneOptions.extraGroupGids = tegraGroupGids;
        console.log(
          `  ✓ Granting sandbox user access to Jetson Tegra GPU device nodes via --group-add ${tegraGroupGids.join(
            ", ",
          )} (so CUDA can open /dev/nvmap)`,
        );
      } else {
        console.warn(
          "  ⚠ Could not resolve the group owning Jetson Tegra GPU device nodes (/dev/nvmap); CUDA may fail with NvRmMemInitNvmap permission denied. Confirm /dev/nvmap exists and is group-readable on the host.",
        );
      }
    }
    const cloneArgs = buildDockerGpuCloneRunArgs(inspect, selection.mode, cloneOptions);

    d.dockerStop(oldContainerId, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    const renameResult = d.dockerRename(oldContainerId, backupContainerName, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    if (!isZeroStatus(renameResult)) {
      throw new Error(
        `Could not move original sandbox container aside: ${resultText(renameResult)}`,
      );
    }

    const runResult = d.dockerRunDetached(cloneArgs, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    if (!isZeroStatus(runResult)) {
      context.rolledBack = restoreDockerGpuPatchBackupAfterRecreateFailure(
        { newContainerId: originalName, backupContainerName, originalName },
        deps,
      );
      throw new Error(
        `Could not start GPU-enabled sandbox container: ${resultText(runResult)}; ${
          context.rolledBack
            ? "pre-patch sandbox restored"
            : "rollback failed; pre-patch sandbox was NOT restored"
        }`,
      );
    }

    const newContainerId =
      String(runResult.stdout || "").trim() ||
      waitForNewContainerId(
        options.sandboxName,
        oldContainerId,
        options.timeoutSecs ?? DOCKER_GPU_PATCH_WAIT_SECS,
        deps,
      );
    if (!newContainerId) {
      throw new Error("GPU-enabled sandbox container started, but Docker did not report its ID.");
    }
    context.newContainerId = newContainerId;
    const selectedMode = selection.mode;
    const result = (backupRemoved: boolean): DockerGpuPatchResult => ({
      applied: true,
      oldContainerId,
      newContainerId,
      originalName,
      backupContainerName,
      mode: selectedMode,
      backupRemoved,
    });
    if (options.waitForSupervisor === false) return result(false);

    const execReady = waitForOpenShellSupervisorReconnect(
      options.sandboxName,
      options.timeoutSecs ?? DOCKER_GPU_PATCH_WAIT_SECS,
      deps,
    );
    const reconcile = reconcileSupervisorReconnect(
      execReady,
      { newContainerId, backupContainerName, originalName },
      deps,
    );
    if (!reconcile.execReady) {
      context.rolledBack = reconcile.rolledBack;
      throw reconcile.error;
    }
    return result(reconcile.backupRemoved);
  } catch (error) {
    throw decoratePatchError(error instanceof Error ? error : new Error(String(error)), context);
  }
}
