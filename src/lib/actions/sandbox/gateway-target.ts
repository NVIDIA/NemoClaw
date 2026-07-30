// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_PORT } from "../../core/ports";
import {
  activatePersistedHostContainerRuntime,
  normalizePersistedHostRuntimeDriver,
  type PersistedHostContainerRuntimeDependencies,
  persistedHostContainerRuntimeRequiresBinding,
} from "../../onboard/compute/persisted-host-container-runtime";
import {
  resolveGatewayName,
  resolveManagedGatewayStateDirectory,
  resolveSandboxGatewayName,
  type SandboxGatewayComputeBinding,
} from "../../onboard/gateway-binding";
import * as registry from "../../state/registry";

export function getKnownSandboxTargetGatewayName(sandboxName = ""): string | null {
  const sb = sandboxName ? registry.getSandbox(sandboxName) : null;
  return sb ? resolveSandboxGatewayName(sb) : null;
}

export function getSandboxTargetGatewayName(sandboxName = ""): string {
  return getKnownSandboxTargetGatewayName(sandboxName) ?? resolveGatewayName(GATEWAY_PORT);
}

export function getKnownSandboxOpenShellDriver(sandboxName = ""): string | null {
  return sandboxName ? (registry.getSandbox(sandboxName)?.openshellDriver?.trim() ?? null) : null;
}

export function getSandboxGatewayComputeBinding(
  sandboxName: string,
): SandboxGatewayComputeBinding | null {
  return registry.getSandbox(sandboxName);
}

export function listSandboxGatewayComputeBindings(): readonly SandboxGatewayComputeBinding[] {
  return registry.listSandboxes().sandboxes;
}

export function resolveSandboxManagedGatewayStateDirectory(
  sandbox: SandboxGatewayComputeBinding,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolveManagedGatewayStateDirectory(resolveSandboxGatewayName(sandbox), {
    env: environment,
  });
}

export function activatePersistedSandboxHostContainerRuntime(
  sandbox: SandboxGatewayComputeBinding | null | undefined,
  dependencies: PersistedHostContainerRuntimeDependencies = {},
): () => void {
  if (!sandbox) return () => undefined;
  const driverName = normalizePersistedHostRuntimeDriver(sandbox.openshellDriver);
  const stateDir = persistedHostContainerRuntimeRequiresBinding(driverName)
    ? resolveSandboxManagedGatewayStateDirectory(sandbox, dependencies.environment ?? process.env)
    : null;
  return activatePersistedHostContainerRuntime({ driverName, stateDir }, dependencies);
}

export function activatePersistedGatewayHostContainerRuntime(
  target: {
    readonly driverName: string;
    readonly gatewayName: string;
  },
  dependencies: PersistedHostContainerRuntimeDependencies = {},
): () => void {
  const driverName = normalizePersistedHostRuntimeDriver(target.driverName);
  const stateDir = persistedHostContainerRuntimeRequiresBinding(driverName)
    ? resolveManagedGatewayStateDirectory(target.gatewayName, {
        env: dependencies.environment ?? process.env,
      })
    : null;
  return activatePersistedHostContainerRuntime({ driverName, stateDir }, dependencies);
}

/**
 * Injectable command boundary for standalone lifecycle facades. Tests that
 * deliberately use synthetic registry rows can replace one method without
 * weakening production qualification or mocking the adapter implementation.
 */
export const persistedHostContainerRuntimeActivation = {
  activateGateway: activatePersistedGatewayHostContainerRuntime,
  activateSandbox: activatePersistedSandboxHostContainerRuntime,
};

export function gatewayNamePattern(gatewayName: string): RegExp {
  return new RegExp(
    `Gateway:\\s+${gatewayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`,
    "i",
  );
}
