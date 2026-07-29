// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellComputePlan } from "./plan";

export type ManagedGatewayLaunchPolicy = "docker-compat" | "host-only";
export type ManagedGatewaySandboxReachability = "docker-bridge" | "podman-host" | "driver-native";
export type ManagedGatewayRuntimeMarkerPolicy = "docker-compat-v1" | "process-env";

export interface ManagedGatewayDriverCapabilities {
  readonly containerizedGatewayCompat: boolean;
  readonly legacyDockerGatewayCleanup: boolean;
  readonly legacyDockerVolumeCleanup: boolean;
  readonly localSupervisorBinary: boolean;
  readonly packageManagedService: boolean;
}

export interface ManagedGatewayDriverProfile {
  readonly allowWildcardBind: boolean;
  readonly driverName: string;
  readonly displayName: string;
  readonly incompatibleRuntimeEnvironmentKeys: readonly string[];
  readonly launchPolicy: ManagedGatewayLaunchPolicy;
  readonly runtimeMarkerPolicy: ManagedGatewayRuntimeMarkerPolicy;
  readonly runtimeEnvironmentKeys: readonly string[];
  readonly sandboxReachability: ManagedGatewaySandboxReachability;
  readonly capabilities: ManagedGatewayDriverCapabilities;
}

export type ManagedGatewayDriverProfileRegistry = Readonly<
  Record<string, ManagedGatewayDriverProfile>
>;

export interface ManagedGatewayRuntimeAdapter {
  readonly driverName: string;
  readonly launchPolicy: ManagedGatewayLaunchPolicy;
  readonly runtimeMarkerPolicy: ManagedGatewayRuntimeMarkerPolicy;
  readonly sandboxReachability: ManagedGatewaySandboxReachability;
}

export type ManagedGatewayRuntimeAdapterRegistry<
  TAdapter extends ManagedGatewayRuntimeAdapter = ManagedGatewayRuntimeAdapter,
> = Readonly<Record<string, TAdapter>>;

export const CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES = {
  docker: {
    allowWildcardBind: false,
    driverName: "docker",
    displayName: "Docker",
    incompatibleRuntimeEnvironmentKeys: ["OPENSHELL_PODMAN_SOCKET", "OPENSHELL_SUPERVISOR_IMAGE"],
    launchPolicy: "docker-compat",
    runtimeMarkerPolicy: "docker-compat-v1",
    runtimeEnvironmentKeys: ["DOCKER_HOST"],
    sandboxReachability: "docker-bridge",
    capabilities: {
      containerizedGatewayCompat: true,
      legacyDockerGatewayCleanup: true,
      legacyDockerVolumeCleanup: true,
      localSupervisorBinary: true,
      packageManagedService: true,
    },
  },
  podman: {
    allowWildcardBind: true,
    driverName: "podman",
    displayName: "Podman",
    incompatibleRuntimeEnvironmentKeys: [
      "DOCKER_HOST",
      "OPENSHELL_DOCKER_NETWORK_NAME",
      "OPENSHELL_DOCKER_SUPERVISOR_IMAGE",
      "OPENSHELL_DOCKER_SUPERVISOR_BIN",
      "OPENSHELL_GRPC_ENDPOINT",
      "OPENSHELL_DISABLE_GATEWAY_AUTH",
      "OPENSHELL_DISABLE_TLS",
    ],
    launchPolicy: "host-only",
    runtimeMarkerPolicy: "process-env",
    runtimeEnvironmentKeys: ["OPENSHELL_PODMAN_SOCKET"],
    sandboxReachability: "podman-host",
    capabilities: {
      containerizedGatewayCompat: false,
      legacyDockerGatewayCleanup: false,
      legacyDockerVolumeCleanup: false,
      localSupervisorBinary: false,
      packageManagedService: true,
    },
  },
} as const satisfies ManagedGatewayDriverProfileRegistry;

export class ManagedGatewayDriverProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedGatewayDriverProfileError";
  }
}

/**
 * Resolve the NemoClaw-owned gateway profile independently from compute
 * identity. OpenShell-owned and future extension launchers do not inherit a
 * Docker/Podman host lifecycle simply because their driver name is known.
 */
export function resolveManagedGatewayDriverProfile(
  plan: OpenShellComputePlan,
  profiles: ManagedGatewayDriverProfileRegistry = CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES,
): ManagedGatewayDriverProfile | null {
  if (plan.gatewayLauncher !== "nemoclaw") return null;
  const profile = Object.hasOwn(profiles, plan.driverName) ? profiles[plan.driverName] : undefined;
  if (!profile || profile.driverName !== plan.driverName) {
    throw new ManagedGatewayDriverProfileError(
      `OpenShell compute driver '${plan.driverName}' requires a registered NemoClaw managed-gateway profile.`,
    );
  }
  return profile;
}

export function isDockerComputeDriver(plan: OpenShellComputePlan): boolean {
  return plan.driverName === "docker";
}

/**
 * Decide whether install-integrity validation must include a host-visible
 * `openshell-sandbox` binary. Managed runtimes own this requirement through
 * their profile; externally launched runtimes retain the existing platform
 * fallback. An explicitly configured binary is always validated.
 */
export function requiresHostSandboxBinaryForInstall(
  profile: ManagedGatewayDriverProfile | null,
  options: {
    readonly explicitSandboxBinary: boolean;
    readonly platform?: NodeJS.Platform;
  },
): boolean {
  if (options.explicitSandboxBinary) return true;
  if (profile) return profile.capabilities.localSupervisorBinary;
  return (options.platform ?? process.platform) !== "darwin";
}

export function resolveManagedGatewayRuntimeAdapter<TAdapter extends ManagedGatewayRuntimeAdapter>(
  profile: ManagedGatewayDriverProfile,
  adapters: ManagedGatewayRuntimeAdapterRegistry<TAdapter>,
): TAdapter {
  const adapter = Object.hasOwn(adapters, profile.driverName)
    ? adapters[profile.driverName]
    : undefined;
  if (!adapter || adapter.driverName !== profile.driverName) {
    throw new ManagedGatewayDriverProfileError(
      `NemoClaw managed-gateway profile '${profile.driverName}' requires a matching runtime adapter.`,
    );
  }
  if (
    adapter.launchPolicy !== profile.launchPolicy ||
    adapter.runtimeMarkerPolicy !== profile.runtimeMarkerPolicy ||
    adapter.sandboxReachability !== profile.sandboxReachability
  ) {
    throw new ManagedGatewayDriverProfileError(
      `NemoClaw managed-gateway runtime adapter '${profile.driverName}' does not match its registered lifecycle profile.`,
    );
  }
  return adapter;
}
