// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES,
  resolveManagedGatewayDriverProfile,
} from "../../../onboard/compute/managed-gateway-profile";
import { buildPersistedPodmanDriverGatewayEnv } from "../../../onboard/compute/podman/gateway-env";
import {
  createPodmanSandboxCreateRuntimeAuthority,
  type PodmanSandboxCreateRuntimeAuthority,
  type PodmanSandboxCreateRuntimeAuthorityInput,
} from "../../../onboard/compute/podman/sandbox-create-authority";
import type { PodmanSocketAuthority } from "../../../onboard/compute/podman/socket-authority";
import {
  qualifyManagedGatewayRecoveryRuntime,
  resolveManagedGatewayRecoveryRuntime,
} from "../../../onboard/compute/recovery-runtime";
import {
  resolveSandboxRuntimeAuthority,
  type SandboxRuntimeAuthorityAdapterRegistry,
} from "../../../onboard/compute/runtime-authority";
import { readManagedGatewayRuntimeBinding } from "../../../onboard/docker-driver-gateway-config";
import { buildHostManagedGatewayRuntimeIdentity } from "../../../onboard/docker-driver-gateway-launch";
import { createDockerDriverGatewayRuntimeHelpers } from "../../../onboard/docker-driver-gateway-runtime";
import {
  getBlueprintMaxOpenshellVersion,
  getInstalledOpenshellVersion,
  isOpenshellDevVersion,
  SUPPORTED_OPENSHELL_FALLBACK_VERSION,
  shouldUseOpenshellDevChannel,
} from "../../../onboard/openshell-version";
import { isGatewayHealthy } from "../../../state/gateway";
import type { SandboxEntry } from "../../../state/registry";

export interface ManagedSnapshotRuntimeAuthorityContext {
  readonly destinationSandboxName: string;
  readonly sourceEntry: SandboxEntry;
}

type SnapshotAuthorityRegistry =
  SandboxRuntimeAuthorityAdapterRegistry<ManagedSnapshotRuntimeAuthorityContext>;

export interface PodmanManagedSnapshotRuntimeAuthorityDependencies {
  captureOpenshell(
    args: string[],
    options: { ignoreError: true },
  ): { readonly output?: string | null };
  getOpenshellBinary(): string;
  resolveGatewayPortFromName(gatewayName: string): number | null;
  resolveManagedGatewayStateDirectory(gatewayName: string): string;
  resolveSandboxGatewayName(sourceEntry: SandboxEntry): string;
  runCapture(args: string[], options?: { ignoreError?: boolean }): string;
  qualifyRecoveryRuntime?: typeof qualifyManagedGatewayRecoveryRuntime;
  createRuntimeAuthority?: (
    input: PodmanSandboxCreateRuntimeAuthorityInput,
  ) => PodmanSandboxCreateRuntimeAuthority;
}

function captureOutput(
  deps: PodmanManagedSnapshotRuntimeAuthorityDependencies,
  args: string[],
): string {
  return deps.captureOpenshell(args, { ignoreError: true }).output ?? "";
}

function requireQualifiedPodmanSocketAuthority(
  qualification: unknown,
  expectedSocketPath: string,
): PodmanSocketAuthority {
  if (!qualification || typeof qualification !== "object") {
    throw new Error("Managed Podman runtime qualification returned no socket authority.");
  }
  const receipt = qualification as {
    readonly driverName?: unknown;
    readonly socketAuthority?: Partial<PodmanSocketAuthority>;
    readonly socketPath?: unknown;
  };
  const authority = receipt.socketAuthority;
  if (
    receipt.driverName !== "podman" ||
    receipt.socketPath !== expectedSocketPath ||
    !authority ||
    authority.socketPath !== expectedSocketPath ||
    !Array.isArray(authority.directoryChain) ||
    typeof authority.device !== "string" ||
    typeof authority.inode !== "string" ||
    typeof authority.ownerUid !== "string"
  ) {
    throw new Error("Managed Podman runtime qualification returned mismatched socket authority.");
  }
  return authority as PodmanSocketAuthority;
}

export function createPodmanManagedSnapshotRuntimeAuthority(
  context: ManagedSnapshotRuntimeAuthorityContext,
  deps: PodmanManagedSnapshotRuntimeAuthorityDependencies,
): PodmanSandboxCreateRuntimeAuthority {
  const sourceEntry = context.sourceEntry as SandboxEntry;
  const gatewayName = deps.resolveSandboxGatewayName(sourceEntry);
  const gatewayPort = deps.resolveGatewayPortFromName(gatewayName);
  if (gatewayPort === null) {
    throw new Error(`Managed Podman snapshot source has invalid gateway '${gatewayName}'.`);
  }
  const stateDir = deps.resolveManagedGatewayStateDirectory(gatewayName);
  const binding = readManagedGatewayRuntimeBinding(stateDir);
  if (!binding) {
    throw new Error(`Managed Podman runtime binding is missing in '${stateDir}'.`);
  }
  const recovery = resolveManagedGatewayRecoveryRuntime(
    { driverName: "podman", stateDir },
    undefined,
    () => binding,
  );
  const socketPath = recovery.environment.OPENSHELL_PODMAN_SOCKET;
  const supervisorImage = recovery.environment.OPENSHELL_SUPERVISOR_IMAGE;
  if (!socketPath || !supervisorImage) {
    throw new Error("Managed Podman runtime binding is missing its socket or supervisor image.");
  }
  const qualification = (deps.qualifyRecoveryRuntime ?? qualifyManagedGatewayRecoveryRuntime)(
    recovery,
  );
  const socketAuthority = requireQualifiedPodmanSocketAuthority(qualification, socketPath);
  const runtimeHelpers = createDockerDriverGatewayRuntimeHelpers({
    gatewayPort,
    getCachedOpenshellBinary: deps.getOpenshellBinary,
    getBlueprintMaxOpenshellVersion,
    getInstalledOpenshellVersion,
    isOpenshellDevVersion,
    runCapture: deps.runCapture,
    shouldUseOpenshellDevChannel,
    stateDir,
    supportedOpenshellFallbackVersion: SUPPORTED_OPENSHELL_FALLBACK_VERSION,
  });
  const gatewayBin = runtimeHelpers.resolveOpenShellGatewayBinary();
  if (!gatewayBin) {
    throw new Error("Managed Podman snapshot clone could not resolve the gateway binary.");
  }
  const profile = resolveManagedGatewayDriverProfile(
    { driverName: "podman", gatewayLauncher: "nemoclaw" },
    CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES,
  );
  if (!profile) throw new Error("Managed Podman gateway profile is unavailable.");
  const gatewayEnv = buildPersistedPodmanDriverGatewayEnv({
    configSha256: binding.configSha256,
    gatewayPort,
    podmanSocketPath: socketPath,
    stateDir,
    supervisorImage,
  });
  const runtimeIdentity = buildHostManagedGatewayRuntimeIdentity({
    gatewayBin,
    gatewayEnv,
    gatewayName,
    removeEnvironmentKeys: profile.incompatibleRuntimeEnvironmentKeys,
    runtimeEnvironmentKeys: profile.runtimeEnvironmentKeys,
  });
  return (deps.createRuntimeAuthority ?? createPodmanSandboxCreateRuntimeAuthority)({
    driverLabel: profile.displayName,
    gatewayBin,
    gatewayName,
    gatewayPort,
    getRememberedGatewayPid: runtimeHelpers.getDockerDriverGatewayPid,
    getRuntimeDrift: (pid, desiredEnv, driftGatewayBin, trustedServicePid) =>
      runtimeHelpers.getDockerDriverGatewayReuseDrift(
        pid,
        { ...desiredEnv },
        driftGatewayBin,
        trustedServicePid,
      ),
    isGatewayHealthy: () =>
      isGatewayHealthy(
        captureOutput(deps, ["status"]),
        captureOutput(deps, ["gateway", "info", "-g", gatewayName]),
        captureOutput(deps, ["gateway", "info"]),
      ),
    isPidAlive: runtimeHelpers.isPidAlive,
    rememberGatewayPid: runtimeHelpers.rememberDockerDriverGatewayPid,
    runtimeIdentity,
    socketAuthority,
    socketPath,
    stateDir,
  });
}

export function currentManagedSnapshotRuntimeAuthorityAdapters(
  createPodman: (
    context: ManagedSnapshotRuntimeAuthorityContext,
  ) => PodmanSandboxCreateRuntimeAuthority,
): SnapshotAuthorityRegistry {
  return {
    docker: { driverName: "docker", resolve: () => null },
    kubernetes: { driverName: "kubernetes", resolve: () => null },
    podman: { driverName: "podman", resolve: createPodman },
  };
}

export function resolveManagedSnapshotRuntimeAuthority(
  driverName: string,
  context: ManagedSnapshotRuntimeAuthorityContext,
  adapters: SnapshotAuthorityRegistry,
): unknown {
  return resolveSandboxRuntimeAuthority(driverName, context, adapters);
}
