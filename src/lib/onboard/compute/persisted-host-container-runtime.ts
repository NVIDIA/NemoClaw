// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ManagedGatewayRuntimeBinding } from "../docker-driver-gateway-config";
import {
  activateHostLocalInferenceRuntime,
  CURRENT_HOST_LOCAL_INFERENCE_RUNTIME_ADAPTERS,
  type HostLocalInferenceRuntimeActivationInput,
  type HostLocalInferenceRuntimeAdapterRegistry,
} from "./host-local-inference-runtime";
import {
  CURRENT_MANAGED_GATEWAY_RECOVERY_ADAPTERS,
  type ManagedGatewayRecoveryAdapterRegistry,
  type ManagedGatewayRecoveryRuntime,
  qualifyManagedGatewayRecoveryRuntime,
  resolveManagedGatewayRecoveryRuntime,
} from "./recovery-runtime";

export interface PersistedHostContainerRuntimeTarget {
  readonly driverName?: string | null;
  readonly stateDir?: string | null;
}

export interface PersistedHostContainerRuntimeDependencies {
  readonly activateHostRuntime?: typeof activateHostLocalInferenceRuntime;
  readonly environment?: NodeJS.ProcessEnv;
  readonly hostRuntimeAdapters?: HostLocalInferenceRuntimeAdapterRegistry;
  readonly hostRuntimeInput?: Omit<
    HostLocalInferenceRuntimeActivationInput,
    "environment" | "qualifiedRuntime"
  >;
  readonly qualifyRecoveryRuntime?: (
    runtime: ManagedGatewayRecoveryRuntime,
    adapters: ManagedGatewayRecoveryAdapterRegistry,
  ) => unknown;
  readonly readRuntimeBinding?: (stateDir: string) => ManagedGatewayRuntimeBinding | null;
  readonly recoveryRuntimeAdapters?: ManagedGatewayRecoveryAdapterRegistry;
  readonly resolveRecoveryRuntime?: (
    options: {
      readonly driverName: string;
      readonly environment?: NodeJS.ProcessEnv;
      readonly stateDir: string;
    },
    adapters: ManagedGatewayRecoveryAdapterRegistry,
    readBinding?: (stateDir: string) => ManagedGatewayRuntimeBinding | null,
  ) => ManagedGatewayRecoveryRuntime;
}

const DIRECT_HOST_RUNTIME_DRIVERS = new Set(["docker", "kubernetes"]);

export function normalizePersistedHostRuntimeDriver(driverName?: string | null): string {
  const normalized = driverName?.trim() || "docker";
  // Registry rows from the legacy VM era used Docker-compatible host
  // inference and image ownership. Keep that migration explicit here.
  return normalized === "vm" ? "docker" : normalized;
}

/**
 * Reconstruct the exact host-container engine selected by durable runtime
 * state. Native/future managed drivers must resolve and qualify their protected
 * binding before any shared Docker-compatible adapter can execute.
 */
export function activatePersistedHostContainerRuntime(
  target: PersistedHostContainerRuntimeTarget,
  dependencies: PersistedHostContainerRuntimeDependencies = {},
): () => void {
  const driverName = normalizePersistedHostRuntimeDriver(target.driverName);
  const environment = dependencies.environment ?? process.env;
  const activate = dependencies.activateHostRuntime ?? activateHostLocalInferenceRuntime;
  const hostRuntimeAdapters =
    dependencies.hostRuntimeAdapters ?? CURRENT_HOST_LOCAL_INFERENCE_RUNTIME_ADAPTERS;
  const hostRuntimeInput = dependencies.hostRuntimeInput ?? {};

  if (DIRECT_HOST_RUNTIME_DRIVERS.has(driverName)) {
    return activate(
      { driverName },
      {
        ...hostRuntimeInput,
        environment,
      },
      hostRuntimeAdapters,
    );
  }

  const stateDir = target.stateDir?.trim();
  if (!stateDir) {
    throw new Error(
      `Persisted OpenShell compute driver '${driverName}' requires a managed runtime binding.`,
    );
  }
  const recoveryRuntimeAdapters =
    dependencies.recoveryRuntimeAdapters ?? CURRENT_MANAGED_GATEWAY_RECOVERY_ADAPTERS;
  const resolveRecovery =
    dependencies.resolveRecoveryRuntime ?? resolveManagedGatewayRecoveryRuntime;
  const recoveryRuntime = resolveRecovery(
    {
      driverName,
      environment,
      stateDir,
    },
    recoveryRuntimeAdapters,
    dependencies.readRuntimeBinding,
  );
  const qualifyRecovery =
    dependencies.qualifyRecoveryRuntime ?? qualifyManagedGatewayRecoveryRuntime;
  const qualification = qualifyRecovery(recoveryRuntime, recoveryRuntimeAdapters);
  const recoveredEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    ...recoveryRuntime.environment,
  };

  return activate(
    { driverName },
    {
      ...hostRuntimeInput,
      environment: recoveredEnvironment,
      qualifiedRuntime: qualification,
    },
    hostRuntimeAdapters,
  );
}

export function persistedHostContainerRuntimeRequiresBinding(driverName?: string | null): boolean {
  return !DIRECT_HOST_RUNTIME_DRIVERS.has(normalizePersistedHostRuntimeDriver(driverName));
}
