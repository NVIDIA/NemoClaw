// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellComputePlan } from "../compute/plan";
import { managedImagePlatformForNodeArchitecture } from "../managed-image/contract";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
  type RuntimeProviderManagedImageSupport,
  resolveRuntimeProviderBundle,
} from "../runtime-provider/access";
import type { PortableAgentRuntimeProviderSupport } from "./portable-agent-runtime";
import type { SandboxWorkloadRuntimeCapabilities } from "./source";

function hostOciArchitecture(nodeArchitecture: string): string {
  if (nodeArchitecture === "x64") return "amd64";
  return nodeArchitecture;
}

function cloneRuntimeSupport(
  support: RuntimeProviderManagedImageSupport,
  platform: NonNullable<ReturnType<typeof managedImagePlatformForNodeArchitecture>>,
): RuntimeProviderManagedImageSupport {
  return {
    exactDigestReferences: support.exactDigestReferences,
    platforms: [platform],
    startupProfileContractVersions: [...support.startupProfileContractVersions],
    capabilityContractVersions: [...support.capabilityContractVersions],
  };
}

function clonePortableRuntimeSupport(
  support: PortableAgentRuntimeProviderSupport,
  platform: PortableAgentRuntimeProviderSupport["platforms"][number],
): PortableAgentRuntimeProviderSupport {
  return {
    exactDigestReferences: support.exactDigestReferences,
    agents: [...support.agents],
    platforms: [platform],
    contractVersions: [...support.contractVersions],
    capabilityContractVersions: [...support.capabilityContractVersions],
    tokenizedStartupCommands: support.tokenizedStartupCommands,
    openshellSandboxCommand: support.openshellSandboxCommand,
    openshellNonRootIdentity: support.openshellNonRootIdentity,
    openshellWorkspaceOwnership: support.openshellWorkspaceOwnership,
    ownerOnlyPrivateState: support.ownerOnlyPrivateState,
  };
}

export function resolveSandboxWorkloadRuntimeCapabilities(
  plan: Pick<OpenShellComputePlan, "driverName">,
  providers: RuntimeProviderBundleRegistry = CURRENT_RUNTIME_PROVIDER_BUNDLES,
  nodeArchitecture: string = process.arch,
): SandboxWorkloadRuntimeCapabilities {
  const profile = resolveRuntimeProviderBundle(plan.driverName, providers)?.workload.profile;
  const support = profile?.support;
  const portableSupport = profile?.portableAgentRuntimeSupport;
  const hostPlatform = managedImagePlatformForNodeArchitecture(nodeArchitecture);
  const hostArchitectureSupported =
    hostPlatform !== null &&
    profile?.hostArchitectures.includes(hostOciArchitecture(nodeArchitecture)) === true;
  const managedImageSupportedHost =
    hostArchitectureSupported &&
    support !== undefined &&
    support !== null &&
    support.platforms.includes(hostPlatform);
  const portableRuntimeSupportedHost =
    hostArchitectureSupported &&
    portableSupport !== undefined &&
    portableSupport !== null &&
    portableSupport.platforms.includes(hostPlatform);
  return {
    driverName: plan.driverName,
    managedImageSelectionPolicy: profile?.managedImageSelectionPolicy ?? "require-managed",
    legacyDockerfileBuilds: profile?.legacyDockerfileBuilds ?? false,
    managedImages:
      support === undefined ||
      support === null ||
      hostPlatform === null ||
      !managedImageSupportedHost
        ? null
        : cloneRuntimeSupport(support, hostPlatform),
    portableAgentRuntime:
      portableSupport === undefined ||
      portableSupport === null ||
      hostPlatform === null ||
      !portableRuntimeSupportedHost
        ? null
        : clonePortableRuntimeSupport(portableSupport, hostPlatform),
  };
}
