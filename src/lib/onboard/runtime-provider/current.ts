// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  composeActivatedRuntimeProviderBundles,
  type RuntimeProviderActivationRegistration,
} from "./activation";
import type { RuntimeProviderBundle, RuntimeProviderBundleRegistry } from "./contract";
import { createDockerRuntimeProviderBundle, createKubernetesRuntimeProviderBundle } from "./docker";
import { createRuntimeProviderBundleRegistry, requireRuntimeProviderBundle } from "./registry";

/**
 * The production-selectable set remains intentionally limited to the two
 * providers NemoClaw already ships. Future providers must land as one complete
 * bundle and separately pass their activation gate.
 */
const ESTABLISHED_RUNTIME_PROVIDER_BUNDLES: RuntimeProviderBundleRegistry =
  createRuntimeProviderBundleRegistry([
    ["docker", createDockerRuntimeProviderBundle()],
    ["kubernetes", createKubernetesRuntimeProviderBundle()],
  ]);

export function createCurrentRuntimeProviderBundles(
  activations: readonly RuntimeProviderActivationRegistration[] = [],
): RuntimeProviderBundleRegistry {
  return composeActivatedRuntimeProviderBundles(ESTABLISHED_RUNTIME_PROVIDER_BUNDLES, activations);
}

export const CURRENT_RUNTIME_PROVIDER_BUNDLES: RuntimeProviderBundleRegistry =
  createCurrentRuntimeProviderBundles();

export function resolveCurrentRuntimeProviderBundle(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  providers: RuntimeProviderBundleRegistry = CURRENT_RUNTIME_PROVIDER_BUNDLES,
): RuntimeProviderBundle {
  const managedLocalGateway = platform === "linux" || (platform === "darwin" && arch === "arm64");
  return requireRuntimeProviderBundle(managedLocalGateway ? "docker" : "kubernetes", providers);
}
