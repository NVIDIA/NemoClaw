// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  dockerCapture,
  dockerRename,
  dockerRm,
  dockerRun,
  dockerRunDetached,
  dockerStart,
  dockerStop,
} from "../adapters/docker";
import { hasZeroDockerExitStatus } from "./docker-command-result";
import { detectSandboxFallbackDns } from "./docker-gpu-dns-fallback";
import { detectTegraDeviceGroupGids } from "./docker-gpu-jetson-groups";
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
import type {
  DockerContainerInspect,
  DockerGpuPatchDeps,
  DockerGpuPatchFailureContext,
  DockerGpuPatchMode,
  DockerGpuPatchResult,
} from "./docker-gpu-patch-types";
import { waitForOpenShellSupervisorReconnect } from "./docker-gpu-supervisor-reconnect";
import { openshellSandboxCommandEnvValue } from "./docker-startup-command-env";
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
    | "dockerStart"
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
    dockerStart,
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
    error?: Error | null;
  } | null,
): string {
  if (!result) return "";
  return `${String(result.stderr || "")} ${String(result.stdout || "")} ${String(
    result.error?.message || "",
  )}`.trim();
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

export function recreateOpenShellDockerSandboxContainer(
  options: {
    sandboxName: string;
    gpuDevice?: string | null;
    timeoutSecs?: number;
    waitForSupervisor?: boolean;
    openshellSandboxCommand?: readonly string[] | null;
    expectedOldContainerId?: string | null;
    backend?: "generic" | "jetson";
    dockerDesktopWsl?: boolean;
    modeOverride?: DockerGpuPatchMode;
  },
  deps: DockerGpuPatchDeps = {},
): DockerGpuPatchResult {
  const d = recreateDeps(deps);
  const context: DockerGpuPatchFailureContext = {
    sandboxName: options.sandboxName,
    modeAttempts: [],
  };
  try {
    const containerIds = findOpenShellDockerSandboxContainerIds(options.sandboxName, deps);
    const oldContainerId = containerIds[0];
    if (!oldContainerId) {
      throw new Error(
        `Could not find OpenShell Docker container for sandbox '${options.sandboxName}'.`,
      );
    }
    if (
      options.expectedOldContainerId != null &&
      (containerIds.length !== 1 || oldContainerId !== options.expectedOldContainerId)
    ) {
      throw new Error(
        `OpenShell Docker container identity changed for sandbox '${options.sandboxName}'; ` +
          "refusing startup-command recreation because the observed container differs from the pinned identity.",
      );
    }
    if (options.openshellSandboxCommand != null) {
      // Validate the persisted command before image selection so malformed
      // tokens fail before any container mutation can begin.
      openshellSandboxCommandEnvValue(options.openshellSandboxCommand);
    }
    context.oldContainerId = oldContainerId;
    const inspect = inspectDockerContainer(oldContainerId, deps);
    const configuredImage = String(inspect.Config?.Image || "").trim();
    if (!configuredImage) {
      throw new Error("OpenShell sandbox container inspect did not include an image.");
    }
    const immutableImage = String(inspect.Image || "").trim();
    const requiresImmutableImage = options.openshellSandboxCommand != null;
    if (requiresImmutableImage && !/^sha256:[0-9a-f]{64}$/i.test(immutableImage)) {
      throw new Error(
        "OpenShell sandbox container inspect did not include a valid immutable image ID; " +
          "refusing startup-command recreation from a mutable image tag.",
      );
    }
    const image = requiresImmutableImage ? immutableImage : configuredImage;

    const selection = options.modeOverride
      ? { mode: options.modeOverride, attempts: [] }
      : selectDockerGpuPatchMode(
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
    cloneOptions.image = image;
    cloneOptions.openshellSandboxCommand = options.openshellSandboxCommand ?? null;
    const sandboxFallbackDns = d.detectSandboxFallbackDns();
    if (sandboxFallbackDns) cloneOptions.sandboxFallbackDns = sandboxFallbackDns;
    if (selection.mode.kind !== "startup-command" && options.backend === "jetson") {
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

    const containerMutationOptions = {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    };
    const stopResult = d.dockerStop(oldContainerId, containerMutationOptions);
    if (!hasZeroDockerExitStatus(stopResult)) {
      context.rolledBack = hasZeroDockerExitStatus(
        d.dockerStart(oldContainerId, containerMutationOptions),
      );
      throw new Error(
        `Could not stop original sandbox container: ${resultText(stopResult)}; ${
          context.rolledBack
            ? "original sandbox container confirmed running"
            : "restart failed; original sandbox container may be stopped"
        }`,
      );
    }
    const renameResult = d.dockerRename(
      oldContainerId,
      backupContainerName,
      containerMutationOptions,
    );
    if (!hasZeroDockerExitStatus(renameResult)) {
      d.dockerRename(backupContainerName, originalName, containerMutationOptions);
      const restarted = hasZeroDockerExitStatus(
        d.dockerStart(oldContainerId, containerMutationOptions),
      );
      let originalNameRestored = false;
      try {
        originalNameRestored =
          dockerContainerName(inspectDockerContainer(oldContainerId, deps)) === originalName;
      } catch {
        originalNameRestored = false;
      }
      context.rolledBack = restarted && originalNameRestored;
      throw new Error(
        `Could not move original sandbox container aside: ${resultText(renameResult)}; ${
          context.rolledBack
            ? "original sandbox container restored"
            : "restore failed; original sandbox container state is uncertain"
        }`,
      );
    }

    const runResult = d.dockerRunDetached(cloneArgs, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    if (!hasZeroDockerExitStatus(runResult)) {
      context.rolledBack = restoreDockerGpuPatchBackupAfterRecreateFailure(
        { newContainerId: originalName, backupContainerName, originalName },
        deps,
      );
      const containerDescription =
        selection.mode.kind === "startup-command"
          ? "recreated sandbox container"
          : "GPU-enabled sandbox container";
      throw new Error(
        `Could not start ${containerDescription}: ${resultText(runResult)}; ${
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
      context.rolledBack = restoreDockerGpuPatchBackupAfterRecreateFailure(
        { newContainerId: originalName, backupContainerName, originalName },
        deps,
      );
      const containerDescription =
        selection.mode.kind === "startup-command"
          ? "Recreated sandbox container"
          : "GPU-enabled sandbox container";
      throw new Error(
        `${containerDescription} started, but Docker did not report its ID; ${
          context.rolledBack
            ? "pre-patch sandbox restored"
            : "rollback failed; pre-patch sandbox was NOT restored"
        }`,
      );
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

export const recreateOpenShellDockerSandboxWithGpu: (
  options: Omit<Parameters<typeof recreateOpenShellDockerSandboxContainer>[0], "modeOverride">,
  deps?: DockerGpuPatchDeps,
) => DockerGpuPatchResult = recreateOpenShellDockerSandboxContainer;
