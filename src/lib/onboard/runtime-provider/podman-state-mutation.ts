// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PodmanBoundContainerEngine } from "../../adapters/podman";
import type { RuntimeProviderStateMutationSurface } from "./contract";
import {
  createContainerStateMutationSurface,
  type ContainerStateMutationSurfaceOptions,
} from "./container-state-mutation";
import {
  NATIVE_PODMAN_RESOURCE_LABEL,
  NATIVE_PODMAN_RESOURCE_LABEL_VALUE,
  normalizePodmanLogicalMounts,
  resolvePodmanStorageGraphRoot,
} from "./podman-runtime-surfaces";

export interface PodmanStateMutationSurfaceOptions {
  readonly engine: PodmanBoundContainerEngine;
  readonly resolveStateDir?: ContainerStateMutationSurfaceOptions["resolveStateDir"];
  readonly withDirectSandboxExecutionExclusion?: ContainerStateMutationSurfaceOptions["withDirectSandboxExecutionExclusion"];
}

/** Candidate-only Podman facet bound to one qualified socket and executable. */
export function createPodmanStateMutationSurface(
  options: PodmanStateMutationSurfaceOptions,
): Extract<RuntimeProviderStateMutationSurface, { readonly supported: true }> {
  if (options.engine.engineId !== "podman" || options.engine.operation !== "state-mutation") {
    throw new Error("Podman state mutation requires a 'state-mutation' Podman engine.");
  }
  const surfaceOptions: ContainerStateMutationSurfaceOptions = {
    providerId: "podman",
    providerDisplayName: "Podman",
    engineOperation: "state-mutation",
    runtimeIdInspectField: "ID",
    privatePidMode: "private",
    managedLabelKey: NATIVE_PODMAN_RESOURCE_LABEL,
    managedLabelValue: NATIVE_PODMAN_RESOURCE_LABEL_VALUE,
    normalizeInspectionMounts: (mounts, runtimeId) =>
      normalizePodmanLogicalMounts(
        mounts,
        resolvePodmanStorageGraphRoot(options.engine),
        runtimeId,
      ),
    createAuthority: () => ({
      assertAuthority: options.engine.assertAuthority,
      engine: options.engine,
    }),
    ...(options.resolveStateDir ? { resolveStateDir: options.resolveStateDir } : {}),
    ...(options.withDirectSandboxExecutionExclusion
      ? {
          withDirectSandboxExecutionExclusion: options.withDirectSandboxExecutionExclusion,
        }
      : {}),
  };
  return createContainerStateMutationSurface(surfaceOptions);
}
