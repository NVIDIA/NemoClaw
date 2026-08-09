// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxWorkloadReceipt } from "../../state/registry/types";
import {
  assessWindowsMxcProcessContainerCandidate,
  type WindowsMxcHostFacts,
} from "../windows-mxc/host-qualification";
import {
  MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  NATIVE_ARTIFACT_WORKLOAD_AGENT,
  NATIVE_ARTIFACT_WORKLOAD_CONTRACT_VERSION,
  NATIVE_ARTIFACT_WORKLOAD_PLATFORM,
  parseNativeArtifactWorkloadReceiptV1,
} from "../workload/native-artifact";
import {
  RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
  type RuntimeProviderBundle,
  type RuntimeProviderDoctorCheck,
  type RuntimeProviderWorkloadProfile,
} from "./contract";

export interface MxcRuntimeProviderOptions {
  readonly hostFacts: WindowsMxcHostFacts;
}

const MXC_PROVIDER_ID = "mxc";

const MXC_NATIVE_ARTIFACT_PROFILE = {
  support: null,
  nativeArtifactSupport: {
    exactDigestReferences: true,
    platforms: [NATIVE_ARTIFACT_WORKLOAD_PLATFORM],
    agents: [NATIVE_ARTIFACT_WORKLOAD_AGENT],
    contractVersions: [NATIVE_ARTIFACT_WORKLOAD_CONTRACT_VERSION],
    startupProfileContractVersions: [MANAGED_STARTUP_PROFILE_SCHEMA_VERSION],
  },
  hostArchitectures: ["x64"],
  managedImageSelectionPolicy: "require-managed",
  legacyDockerfileBuilds: false,
} as const satisfies RuntimeProviderWorkloadProfile;

function unsupported(reason: string) {
  return { providerId: MXC_PROVIDER_ID, supported: false as const, reason };
}

function inspectMxcHost(hostFacts: WindowsMxcHostFacts): RuntimeProviderDoctorCheck {
  const assessment = assessWindowsMxcProcessContainerCandidate(hostFacts);
  if (assessment.candidate) {
    return {
      group: "Host",
      label: "OpenShell MXC process_container candidate",
      status: "info",
      detail: `Windows x64 build ${assessment.windowsBuild} meets the inactive host floor.`,
      hint: "MXC remains unavailable until the OpenShell package and live E2E gates pass.",
    };
  }
  return {
    group: "Host",
    label: "OpenShell MXC process_container candidate",
    status: "fail",
    detail: assessment.detail,
  };
}

function acceptsNativeArtifactReceipt(receipt: SandboxWorkloadReceipt | undefined): boolean {
  if (receipt?.kind !== "native-artifact") return false;
  try {
    parseNativeArtifactWorkloadReceiptV1(receipt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Construct the inactive OpenShell MXC provider candidate.
 *
 * The bundle is intentionally absent from the production registry. Unsupported
 * surfaces record the current OpenShell and live-validation dependencies.
 */
export function createMxcRuntimeProviderBundle({
  hostFacts,
}: MxcRuntimeProviderOptions): RuntimeProviderBundle {
  const lifecycleReason =
    "OpenShell MXC process_container lifecycle termination has not passed live E2E.";
  const cleanupReason =
    "OpenShell MXC exact workload termination and orphan cleanup are not qualified.";
  return {
    identity: {
      contractVersion: RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
      id: MXC_PROVIDER_ID,
      displayName: "OpenShell MXC",
    },
    plan: {
      providerId: MXC_PROVIDER_ID,
      supported: true,
      gatewayLauncher: "openshell",
    },
    capabilities: {
      providerId: MXC_PROVIDER_ID,
      supported: true,
      hostLocalInference: false,
      directLifecycle: false,
      legacyGatewayContainerInspection: false,
      workloadImageCleanup: false,
    },
    preflightDoctor: {
      providerId: MXC_PROVIDER_ID,
      supported: true,
      inspectHost: () => inspectMxcHost(hostFacts),
      preflightLifecycle: () => ({ exitCode: 1, message: lifecycleReason }),
    },
    gateway: {
      providerId: MXC_PROVIDER_ID,
      supported: true,
      launcher: "openshell",
      inspectLegacyContainer: false,
    },
    workload: {
      providerId: MXC_PROVIDER_ID,
      supported: true,
      profile: MXC_NATIVE_ARTIFACT_PROFILE,
      acceptsReceipt: acceptsNativeArtifactReceipt,
    },
    hostLocalInference: unsupported(
      "OpenShell MXC does not provide a host-local-inference lifecycle.",
    ),
    lifecycle: unsupported(lifecycleReason),
    mutationAuthority: unsupported(
      "MXC mutations remain disabled until lifecycle and cleanup pass live E2E.",
    ),
    stateMutation: unsupported(
      "The MXC runtime provider state mutation surface remains disabled until lifecycle and cleanup pass live E2E.",
    ),
    bootstrap: unsupported(
      "The OpenShell MXC driver does not expose a per-sandbox native artifact launch contract.",
    ),
    snapshot: unsupported("OpenShell MXC snapshot and restore are unavailable."),
    recovery: unsupported(
      "OpenShell MXC gateway-restart reconciliation and orphan recovery are unavailable.",
    ),
    cleanup: unsupported(cleanupReason),
    containerEngine: unsupported(
      "MXC has no container-engine operations; OpenShell owns the MXC control plane.",
    ),
  };
}
