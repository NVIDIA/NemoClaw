// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PodmanBoundContainerEngine } from "../../adapters/podman";
import type { RuntimeProviderStateMutationSurface } from "./contract";
import {
  createContainerStateMutationSurface,
  type ContainerStateMutationSurfaceOptions,
} from "./container-state-mutation";

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
