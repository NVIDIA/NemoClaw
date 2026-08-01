// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PodmanSandboxCreateRuntimeAuthority } from "../compute/podman/sandbox-create-authority";
import {
  assertPodmanGpuAttachmentQualified,
  resolvePodmanGpuAttachment,
} from "../compute/podman/gpu-attachment";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import { createPodmanSandboxCreatePatch, type PodmanSandboxCreatePatchOptions } from "./podman";
import type { SandboxCreateRuntimePatch } from "./types";

type RunOpenshell = (
  args: string[],
  options?: Record<string, unknown>,
) => {
  readonly status?: number | null;
  readonly stderr?: Buffer | string | null;
  readonly stdout?: Buffer | string | null;
};

export interface SandboxCreateRuntimeLifecycleContext {
  readonly managedStartupRootApplyRequest?: ManagedStartupRootApplyRequest | null;
  readonly openshellSandboxCommand: readonly string[];
  readonly persistStartupCommand: boolean;
  readonly requiredUlimits?:
    | readonly {
        readonly hard: number;
        readonly name: string;
        readonly soft: number;
      }[]
    | null;
  readonly sandboxGpuEnabled: boolean;
  readonly sandboxGpuDevice?: string | null;
  readonly sandboxName: string;
  readonly timeoutSecs: number;
  readonly deps: {
    readonly runCaptureOpenshell: (args: string[], options?: Record<string, unknown>) => string;
    readonly runOpenshell: RunOpenshell;
    readonly sleep: (seconds: number) => void;
  };
}

/**
 * Driver-neutral request dispatched through the sandbox-create registry.
 *
 * Runtime authority remains opaque to the coordinator. Each registered
 * adapter validates and narrows its own authority before mutation.
 */
export interface SandboxCreateRuntimePatchRequest {
  readonly driverName: string;
  readonly lifecycle: SandboxCreateRuntimeLifecycleContext;
  readonly runtimeAuthority?: unknown;
}

export interface SandboxCreateRuntimePatchAdapter {
  readonly driverName: string;
  create(request: SandboxCreateRuntimePatchRequest): SandboxCreateRuntimePatch;
}

export type SandboxCreateRuntimePatchAdapterRegistry = Readonly<
  Record<string, SandboxCreateRuntimePatchAdapter>
>;

export function createDirectSandboxCreateRuntimePatch(): SandboxCreateRuntimePatch {
  return {
    commitAfterReady() {},
    createFailureMessage: () => null,
    ensureApplied() {},
    exitOnPatchError() {},
    maybeApplyDuringCreate() {},
    revalidateBeforeMutation() {},
    rollbackManagedStartupAfterCreateFailure() {},
    waitForSupervisorReconnectIfNeeded() {},
  };
}

function podmanOptions(request: SandboxCreateRuntimePatchRequest): PodmanSandboxCreatePatchOptions {
  const { lifecycle } = request;
  const authority = request.runtimeAuthority as Partial<PodmanSandboxCreateRuntimeAuthority> | null;
  if (
    !authority ||
    typeof authority !== "object" ||
    typeof authority.socketPath !== "string" ||
    !authority.socketPath.trim() ||
    !authority.socketAuthority ||
    !authority.watcherController
  ) {
    throw new Error("Podman managed startup requires its qualified socket and watcher controller.");
  }
  const gpuAttachment = resolvePodmanGpuAttachment(
    lifecycle.sandboxGpuEnabled,
    lifecycle.sandboxGpuDevice,
  );
  if (gpuAttachment) {
    if (!Array.isArray(authority.cdiDevices)) {
      throw new Error("Podman sandbox GPU attachment requires qualified CDI runtime authority.");
    }
    assertPodmanGpuAttachmentQualified(authority.cdiDevices, gpuAttachment);
  }
  const { runCaptureOpenshell, runOpenshell, sleep } = lifecycle.deps;
  return {
    managedStartupRootApplyRequest: lifecycle.managedStartupRootApplyRequest,
    openshellSandboxCommand: lifecycle.openshellSandboxCommand,
    persistStartupCommand: lifecycle.persistStartupCommand,
    requiredUlimits: lifecycle.requiredUlimits,
    gpuAttachment,
    sandboxName: lifecycle.sandboxName,
    socketAuthority: authority.socketAuthority,
    socketPath: authority.socketPath,
    timeoutSecs: lifecycle.timeoutSecs,
    watcherController: authority.watcherController,
    deps: {
      runCaptureOpenshell,
      runOpenshell,
      sleep,
    },
  };
}

/**
 * Build the in-tree registry while keeping the Docker patch owned by its
 * caller. Non-Docker selections never construct or accept Docker GPU options.
 */
export function currentSandboxCreateRuntimePatchAdapters(
  dockerPatch?: SandboxCreateRuntimePatch,
): SandboxCreateRuntimePatchAdapterRegistry {
  return {
    docker: {
      driverName: "docker",
      create: () => {
        if (!dockerPatch) {
          throw new Error("Docker sandbox-create runtime patch was not composed by its caller.");
        }
        return dockerPatch;
      },
    },
    kubernetes: {
      driverName: "kubernetes",
      create: (request) => {
        if (
          request.lifecycle.managedStartupRootApplyRequest != null ||
          request.lifecycle.persistStartupCommand ||
          (request.lifecycle.requiredUlimits?.length ?? 0) > 0
        ) {
          throw new Error(
            "Kubernetes direct sandbox creation has no managed-startup runtime adapter.",
          );
        }
        return createDirectSandboxCreateRuntimePatch();
      },
    },
    podman: {
      driverName: "podman",
      create: (request) => createPodmanSandboxCreatePatch(podmanOptions(request)),
    },
  };
}

export const CURRENT_SANDBOX_CREATE_RUNTIME_PATCH_ADAPTERS =
  currentSandboxCreateRuntimePatchAdapters();

export function createSandboxCreateRuntimePatch(
  request: SandboxCreateRuntimePatchRequest,
  adapters: SandboxCreateRuntimePatchAdapterRegistry = CURRENT_SANDBOX_CREATE_RUNTIME_PATCH_ADAPTERS,
): SandboxCreateRuntimePatch {
  const adapter = Object.hasOwn(adapters, request.driverName)
    ? adapters[request.driverName]
    : undefined;
  if (!adapter || adapter.driverName !== request.driverName) {
    throw new Error(
      `OpenShell compute driver '${request.driverName}' has no sandbox-create runtime patch adapter.`,
    );
  }
  return adapter.create(request);
}
