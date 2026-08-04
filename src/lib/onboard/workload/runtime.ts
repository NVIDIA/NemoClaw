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

export function resolveSandboxWorkloadRuntimeCapabilities(
  plan: Pick<OpenShellComputePlan, "driverName">,
  providers: RuntimeProviderBundleRegistry = CURRENT_RUNTIME_PROVIDER_BUNDLES,
  nodeArchitecture: string = process.arch,
): SandboxWorkloadRuntimeCapabilities {
  const profile = resolveRuntimeProviderBundle(plan.driverName, providers)?.workload.profile;
  const support = profile?.support;
  const hostPlatform = managedImagePlatformForNodeArchitecture(nodeArchitecture);
  const supportedHost =
    hostPlatform !== null &&
    support !== undefined &&
    support !== null &&
    profile?.hostArchitectures.includes(hostOciArchitecture(nodeArchitecture)) === true &&
    support.platforms.includes(hostPlatform);
  return {
    driverName: plan.driverName,
    managedImageSelectionPolicy: profile?.managedImageSelectionPolicy ?? "require-managed",
    legacyDockerfileBuilds: profile?.legacyDockerfileBuilds ?? false,
    managedImages:
      support === undefined || support === null || !supportedHost
        ? null
        : cloneRuntimeSupport(support, hostPlatform),
  };
}
