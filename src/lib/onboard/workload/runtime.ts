// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellComputePlan } from "../compute/plan";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  managedImagePlatformForNodeArchitecture,
} from "../managed-image/contract";
import type { ManagedImageSelectionPolicy, SandboxWorkloadRuntimeCapabilities } from "./source";

export type ManagedImageRuntimeSupport = NonNullable<
  SandboxWorkloadRuntimeCapabilities["managedImages"]
>;

export interface ManagedImageRuntimeProfile {
  readonly support: ManagedImageRuntimeSupport | null;
  /** OCI host architectures for which the published image cohort is complete. */
  readonly hostArchitectures: readonly string[];
  readonly managedImageSelectionPolicy: ManagedImageSelectionPolicy;
  readonly legacyDockerfileBuilds: boolean;
}

/**
 * Managed-image capabilities are registered by OpenShell compute-driver
 * identity instead of inferred from the gateway launcher. Podman and a future
 * MXC runtime can register this contract without inheriting Docker lifecycle
 * code.
 */
export type ManagedImageRuntimeProfileRegistry = Readonly<
  Record<string, ManagedImageRuntimeProfile>
>;

const COMPLETE_MANAGED_IMAGE_V1_SUPPORT = {
  exactDigestReferences: true,
  platforms: MANAGED_IMAGE_PLATFORMS,
  startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
  capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
} as const satisfies ManagedImageRuntimeSupport;

/**
 * PR #7747 established Docker as the first explicit OpenShell compute-driver
 * identity. Additional runtimes can register the same workload contract here;
 * selection remains independent from driver lifecycle.
 */
export const CURRENT_MANAGED_IMAGE_RUNTIME_PROFILES = {
  docker: {
    support: COMPLETE_MANAGED_IMAGE_V1_SUPPORT,
    hostArchitectures: ["amd64", "arm64"],
    managedImageSelectionPolicy: "require-managed",
    legacyDockerfileBuilds: true,
  },
  kubernetes: {
    support: null,
    hostArchitectures: [],
    managedImageSelectionPolicy: "prefer-managed",
    legacyDockerfileBuilds: true,
  },
} as const satisfies ManagedImageRuntimeProfileRegistry;

function hostOciArchitecture(nodeArchitecture: string): string {
  if (nodeArchitecture === "x64") return "amd64";
  return nodeArchitecture;
}

function cloneRuntimeSupport(
  support: ManagedImageRuntimeSupport,
  platform: NonNullable<ReturnType<typeof managedImagePlatformForNodeArchitecture>>,
): ManagedImageRuntimeSupport {
  return {
    exactDigestReferences: support.exactDigestReferences,
    platforms: [platform],
    startupProfileContractVersions: [...support.startupProfileContractVersions],
    capabilityContractVersions: [...support.capabilityContractVersions],
  };
}

export function resolveSandboxWorkloadRuntimeCapabilities(
  plan: Pick<OpenShellComputePlan, "driverName">,
  profiles: ManagedImageRuntimeProfileRegistry = CURRENT_MANAGED_IMAGE_RUNTIME_PROFILES,
  nodeArchitecture: string = process.arch,
): SandboxWorkloadRuntimeCapabilities {
  const profile = Object.hasOwn(profiles, plan.driverName) ? profiles[plan.driverName] : undefined;
  const hostPlatform = managedImagePlatformForNodeArchitecture(nodeArchitecture);
  const supportedHost =
    hostPlatform !== null &&
    profile?.support !== null &&
    profile?.hostArchitectures.includes(hostOciArchitecture(nodeArchitecture)) === true &&
    profile?.support.platforms.includes(hostPlatform) === true;
  return {
    driverName: plan.driverName,
    managedImageSelectionPolicy: profile?.managedImageSelectionPolicy ?? "require-managed",
    legacyDockerfileBuilds: profile?.legacyDockerfileBuilds ?? false,
    managedImages:
      profile === undefined || profile.support === null || !supportedHost
        ? null
        : cloneRuntimeSupport(profile.support, hostPlatform),
  };
}
