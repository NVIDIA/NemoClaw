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
import { exitOnSandboxGpuConfigErrors } from "../sandbox-gpu-preflight";
import {
  RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
  type RuntimeProviderBundle,
  type RuntimeProviderDoctorCheck,
  type RuntimeProviderNativeArtifactBootstrapSurface,
  type RuntimeProviderWorkloadProfile,
} from "./contract";
import { createMxcNativeArtifactBootstrapSurface } from "./mxc-bootstrap";
import {
  createMxcNativeArtifactBootstrapOperations,
  type MxcNativeArtifactControlPlane,
} from "./mxc-bootstrap-operations";
import {
  qualifyMxcOpenShellAttachment,
  type MxcOpenShellAttachmentAuthority,
  type MxcOpenShellAttachmentObservation,
  type MxcOpenShellAttachmentReceipt,
} from "./mxc-openshell-attachment";
import {
  observeMxcOpenShellAttachment,
  type MxcOpenShellAttachmentObservationRequest,
  type MxcOpenShellFileDigestObserver,
} from "./mxc-openshell-observer";

export interface MxcRuntimeProviderOptions {
  readonly hostFacts: WindowsMxcHostFacts;
  readonly openshellAttachmentAuthority: MxcOpenShellAttachmentAuthority;
  readonly openshellObservation: MxcOpenShellAttachmentObservation;
  readonly bootstrapControlPlane: MxcNativeArtifactControlPlane;
}

export interface MxcExistingInstallationRuntimeProviderOptions {
  readonly hostFacts: WindowsMxcHostFacts;
  readonly openshellAttachmentAuthority: MxcOpenShellAttachmentAuthority;
  readonly attachmentObservation: MxcOpenShellAttachmentObservationRequest;
  readonly bootstrapControlPlane: MxcNativeArtifactControlPlane;
  /** Trusted native boundary; Windows composition must reject reparse points and identity drift. */
  readonly observeFileDigest: MxcOpenShellFileDigestObserver;
}

export interface MxcExistingInstallationRuntimeProviderAttachment {
  readonly provider: RuntimeProviderBundle;
  readonly attachmentReceipt: MxcOpenShellAttachmentReceipt;
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

function inspectMxcHost(
  hostFacts: WindowsMxcHostFacts,
  qualifyAttachment: () => ReturnType<typeof qualifyMxcOpenShellAttachment>,
): RuntimeProviderDoctorCheck {
  const assessment = assessWindowsMxcProcessContainerCandidate(hostFacts);
  if (!assessment.candidate) {
    return {
      group: "Host",
      label: "OpenShell MXC process_container candidate",
      status: "fail",
      detail: assessment.detail,
    };
  }
  try {
    const attachment = qualifyAttachment();
    return {
      group: "Host",
      label: "OpenShell MXC process_container candidate",
      status: "info",
      detail:
        `Windows x64 build ${assessment.windowsBuild} and OpenShell ${attachment.distribution.version} ` +
        "match the inactive attachment contract.",
      hint:
        "This check does not enable MXC. Maintainers must accept a stable OpenShell distribution " +
        "and complete required live E2E coverage before adding production selection.",
    };
  } catch (error) {
    return {
      group: "Host",
      label: "OpenShell MXC process_container candidate",
      status: "fail",
      detail: error instanceof Error ? error.message : "OpenShell attachment validation failed.",
    };
  }
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
  openshellAttachmentAuthority,
  openshellObservation,
  bootstrapControlPlane,
}: MxcRuntimeProviderOptions): RuntimeProviderBundle {
  const lifecycleReason =
    "OpenShell MXC direct start and stop of an existing sandbox are not qualified.";
  const cleanupReason =
    "OpenShell MXC does not expose an immutable resource handle for exact destructive cleanup.";
  const qualifyAttachment = () =>
    qualifyMxcOpenShellAttachment(openshellAttachmentAuthority, openshellObservation);
  const bootstrap = createMxcNativeArtifactBootstrapSurface(
    createMxcNativeArtifactBootstrapOperations(bootstrapControlPlane),
  );
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
      readOnlyHostMounts: {
        supported: false,
        reason: "OpenShell MXC does not expose a qualified host-directory sharing contract.",
      },
    },
    preflightDoctor: {
      providerId: MXC_PROVIDER_ID,
      supported: true,
      inspectHost: () => inspectMxcHost(hostFacts, qualifyAttachment),
      validateSandboxGpu: (config, exitProcess) =>
        exitOnSandboxGpuConfigErrors(config, exitProcess),
      preflightLifecycle: () => ({ exitCode: 1, message: lifecycleReason }),
    },
    gateway: {
      providerId: MXC_PROVIDER_ID,
      supported: true,
      launcher: "openshell",
      inspectLegacyContainer: false,
      ownsHostReadiness: false,
      prepareHostRuntime: () => {
        throw new Error("OpenShell MXC does not launch a host-managed gateway.");
      },
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
    bootstrap: {
      ...bootstrap,
      run: async (input) => {
        qualifyAttachment();
        return bootstrap.run(input);
      },
      recover: async (input) => {
        qualifyAttachment();
        return bootstrap.recover(input);
      },
    },
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

/** Observe one existing installation and retain its exact attachment receipt. */
export async function attachMxcRuntimeProviderBundleFromExistingInstallation({
  hostFacts,
  openshellAttachmentAuthority,
  attachmentObservation,
  bootstrapControlPlane,
  observeFileDigest,
}: MxcExistingInstallationRuntimeProviderOptions): Promise<MxcExistingInstallationRuntimeProviderAttachment> {
  const observeAndQualify = async () => {
    const observation = await observeMxcOpenShellAttachment(
      attachmentObservation,
      observeFileDigest,
    );
    const attachmentReceipt = qualifyMxcOpenShellAttachment(
      openshellAttachmentAuthority,
      observation,
    );
    return { observation, attachmentReceipt };
  };
  const initialAttachment = await observeAndQualify();
  const candidate = createMxcRuntimeProviderBundle({
    hostFacts,
    openshellAttachmentAuthority,
    openshellObservation: initialAttachment.observation,
    bootstrapControlPlane,
  });
  const bootstrap = candidate.bootstrap as RuntimeProviderNativeArtifactBootstrapSurface;
  const provider: RuntimeProviderBundle = {
    ...candidate,
    bootstrap: {
      ...bootstrap,
      run: async (input) => {
        await observeAndQualify();
        return bootstrap.run(input);
      },
      recover: async (input) => {
        await observeAndQualify();
        return bootstrap.recover(input);
      },
    },
  };
  return Object.freeze({
    provider,
    attachmentReceipt: initialAttachment.attachmentReceipt,
  });
}
