// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ContainerEngine,
  type ContainerEngineCommandCapture,
  createContainerEngineCommand,
} from "../container-engine";
import {
  assertPodmanSocketAuthority,
  type PodmanSocketAuthority,
  type PodmanSocketAuthorityDeps,
} from "./socket-authority";

export interface PodmanContainerEngineOptions {
  readonly operation: "host-doctor" | "sandbox-lifecycle";
  readonly socketAuthority: PodmanSocketAuthority;
  readonly executable?: string;
  readonly capture?: ContainerEngineCommandCapture;
  readonly authorityDeps?: PodmanSocketAuthorityDeps;
  readonly assertAuthority?: (
    expected: PodmanSocketAuthority,
    deps?: PodmanSocketAuthorityDeps,
  ) => void;
}

/**
 * Bind one Podman API socket to one provider operation. Callers inject the
 * returned value directly; unlike the retired donor prototype, this never
 * changes how Docker-named helpers behave in the rest of the process.
 */
export function createPodmanContainerEngine(
  options: PodmanContainerEngineOptions,
): ContainerEngine {
  const assertAuthority = options.assertAuthority ?? assertPodmanSocketAuthority;
  return createContainerEngineCommand({
    operation: options.operation,
    engineId: "podman",
    displayName: "Podman",
    executable: options.executable ?? "podman",
    endpointArgs: ["--url", `unix://${options.socketAuthority.socketPath}`],
    capture: options.capture,
    guard: () => assertAuthority(options.socketAuthority, options.authorityDeps),
  });
}

export type { PodmanSocketAuthority } from "./socket-authority";
export { assertPodmanSocketAuthority, capturePodmanSocketAuthority } from "./socket-authority";
