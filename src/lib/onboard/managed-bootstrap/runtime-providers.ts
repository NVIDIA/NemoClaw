// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createDockerManagedBootstrapAdapter } from "./docker";
import {
  type ManagedBootstrapRuntimeProvider,
  type ManagedBootstrapRuntimeProviderRegistry,
  resolveManagedBootstrapRuntimeProvider,
} from "./runtime-provider";

export const DOCKER_MANAGED_BOOTSTRAP_RUNTIME_PROVIDER = Object.freeze({
  driverId: "docker",
  createAdapter: (dependencies = {}) => createDockerManagedBootstrapAdapter(dependencies),
  createReplacementOptions: (intent) => ({
    values: {
      gpuModeArgs: [...intent.acceleration.arguments],
      gpuModeDevice: intent.acceleration.device,
      gpuModeKind: intent.acceleration.strategy,
      gpuModeLabel: intent.acceleration.label,
      requiredUlimits: intent.limits.map((limit) => `${limit.name}=${limit.soft}:${limit.hard}`),
      extraGroupGids: [...intent.supplementaryGroupIds],
    },
  }),
} satisfies ManagedBootstrapRuntimeProvider);

export const CURRENT_MANAGED_BOOTSTRAP_RUNTIME_PROVIDERS = Object.freeze({
  docker: DOCKER_MANAGED_BOOTSTRAP_RUNTIME_PROVIDER,
} satisfies ManagedBootstrapRuntimeProviderRegistry);

export function resolveCurrentManagedBootstrapRuntimeProvider(
  driverName: string,
): ManagedBootstrapRuntimeProvider {
  return resolveManagedBootstrapRuntimeProvider(
    driverName,
    CURRENT_MANAGED_BOOTSTRAP_RUNTIME_PROVIDERS,
  );
}

/**
 * Older registry rows either omitted the driver or used `vm` for the local
 * Docker-backed OpenShell runtime. Preserve that persisted snapshot-clone
 * contract without registering another managed-bootstrap runtime.
 */
export function resolvePersistedManagedBootstrapRuntimeProvider(
  driverName: string | null | undefined,
): ManagedBootstrapRuntimeProvider {
  return resolveCurrentManagedBootstrapRuntimeProvider(
    driverName === undefined || driverName === null || driverName === "vm" ? "docker" : driverName,
  );
}
