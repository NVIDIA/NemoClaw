// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellComputePlan } from "../compute/plan";
import { managedImagePlatformForNodeArchitecture } from "../managed-image/contract";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  RuntimeProviderBundleRegistry,
  RuntimeProviderManagedImageSupport,
  RuntimeProviderWorkloadProfile,
  resolveRuntimeProviderBundle,
} from "../runtime-provider/access";
import type { SandboxWorkloadRuntimeCapabilities } from "./source";

export type ManagedImageRuntimeSupport = RuntimeProviderManagedImageSupport;
export type ManagedImageRuntimeProfile = RuntimeProviderWorkloadProfile;

/**
 * Managed-image capabilities are registered by OpenShell compute-driver
 * identity instead of inferred from the gateway launcher. A future provider
 * can register this contract without inheriting another provider's lifecycle
 * code.
 */
export type ManagedImageRuntimeProfileRegistry = Readonly<
  Record<string, ManagedImageRuntimeProfile>
>;

/** Compatibility view only; RuntimeProviderBundle is the registration source. */
export function projectRuntimeProviderWorkloadProfiles(
  providers: RuntimeProviderBundleRegistry,
): ManagedImageRuntimeProfileRegistry {
  return Object.freeze(
    Object.fromEntries(
      Object.keys(providers).map((providerId) => [
        providerId,
        providers[providerId]?.workload.profile,
      ]),
    ),
  );
}

export const CURRENT_MANAGED_IMAGE_RUNTIME_PROFILES = projectRuntimeProviderWorkloadProfiles(
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
);

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
  providers: RuntimeProviderBundleRegistry = CURRENT_RUNTIME_PROVIDER_BUNDLES,
  nodeArchitecture: string = process.arch,
): SandboxWorkloadRuntimeCapabilities {
  const profile = resolveRuntimeProviderBundle(plan.driverName, providers)?.workload.profile;
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
