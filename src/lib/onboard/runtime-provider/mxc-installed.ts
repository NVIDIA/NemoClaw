// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "./contract";
import type { InstalledRuntimeSession, InstalledRuntimeSessionInput } from "./installed-session";

const providerId = "mxc";
const portableReason = "Installed previews cannot mutate portable persisted sandboxes.";
const unsupported = (reason: string) => ({ providerId, supported: false as const, reason });
const unavailable = (): never => {
  throw new Error(portableReason);
};

/**
 * Installed Windows composition uses the same bundle contract, but grants only
 * private-session operations. It neither activates MXC nor admits artifact receipts.
 */
export function createInstalledMxcRuntimeProviderBundle(
  create: (input: InstalledRuntimeSessionInput) => InstalledRuntimeSession,
): RuntimeProviderBundle {
  return {
    identity: { contractVersion: 1, id: providerId, displayName: "OpenShell MXC" },
    plan: { providerId, supported: true, gatewayLauncher: "openshell" },
    capabilities: {
      providerId,
      supported: true,
      hostLocalInference: false,
      legacyGatewayContainerInspection: false,
      workloadImageCleanup: false,
      readOnlyHostMounts: { supported: false, reason: portableReason },
    },
    preflightDoctor: {
      providerId,
      supported: true,
      inspectHost: () => ({
        group: "Host",
        label: "Installed Windows preview",
        status: "warn",
        detail:
          "The installer validates its own package and host. Protected provider qualification remains required.",
      }),
      validateSandboxGpu: unavailable,
      preflightLifecycle: () => ({ exitCode: 1, message: portableReason }),
    },
    gateway: {
      providerId,
      supported: true,
      launcher: "openshell",
      inspectLegacyContainer: false,
      finalSandboxLiveness: "openshell-only",
      ownsHostReadiness: false,
      observeHostRuntime: unavailable,
      prepareHostRuntime: unavailable,
      installedSession: { providerId, supported: true, create },
    },
    workload: {
      providerId,
      supported: true,
      profile: {
        support: null,
        hostArchitectures: ["arm64"],
        managedImageSelectionPolicy: "require-managed",
        legacyDockerfileBuilds: false,
      },
      acceptsReceipt: () => false,
    },
    hostLocalInference: unsupported("Installed sessions use the configured inference broker."),
    lifecycle: unsupported(portableReason),
    mutationAuthority: unsupported(portableReason),
    bootstrap: unsupported("Installed sessions require the installer's immutable runtime lease."),
    snapshot: unsupported("Portable snapshots are not available for installed previews."),
    recovery: unsupported(portableReason),
    cleanup: unsupported(portableReason),
    containerEngine: unsupported("OpenShell owns MXC; no container engine is exposed."),
  };
}
