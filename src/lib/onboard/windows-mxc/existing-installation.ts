// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "../runtime-provider/contract";
import {
  attachMxcRuntimeProviderBundleFromExistingInstallation,
  type MxcExistingInstallationRuntimeProviderAttachment,
} from "../runtime-provider/mxc";
import type { MxcNativeArtifactControlPlane } from "../runtime-provider/mxc-bootstrap-operations";
import type {
  MxcOpenShellAttachmentAuthority,
  MxcOpenShellAttachmentReceipt,
} from "../runtime-provider/mxc-openshell-attachment";
import type {
  MxcOpenShellAttachmentObservationRequest,
  MxcOpenShellFileDigestObserver,
} from "../runtime-provider/mxc-openshell-observer";
import { createMxcWindowsOpenShellFileDigestObserver } from "../runtime-provider/mxc-windows-file-observer";
import {
  assessWindowsMxcProcessContainerCandidate,
  type WindowsMxcHostFacts,
} from "./host-qualification";
import { observeWindowsMxcNativeHostFacts } from "./native-host-facts";

export interface MxcWindowsExistingInstallationInput {
  readonly openshellAttachmentAuthority: MxcOpenShellAttachmentAuthority;
  readonly attachmentObservation: MxcOpenShellAttachmentObservationRequest;
  readonly bootstrapControlPlane: MxcNativeArtifactControlPlane;
}

interface MxcWindowsExistingInstallationBoundary {
  readonly observeHostFacts: () => WindowsMxcHostFacts;
  readonly observeFileDigest: MxcOpenShellFileDigestObserver;
}

export interface MxcWindowsExistingInstallationComposition extends MxcExistingInstallationRuntimeProviderAttachment {
  readonly provider: RuntimeProviderBundle;
  readonly attachmentReceipt: MxcOpenShellAttachmentReceipt;
  readonly hostFacts: WindowsMxcHostFacts;
}

export class MxcWindowsExistingInstallationError extends Error {
  constructor(message: string) {
    super(`Inactive Windows OpenShell MXC attachment failed: ${message}`);
    this.name = "MxcWindowsExistingInstallationError";
  }
}

function defaultBoundary(): MxcWindowsExistingInstallationBoundary {
  return {
    observeHostFacts: observeWindowsMxcNativeHostFacts,
    observeFileDigest: createMxcWindowsOpenShellFileDigestObserver(),
  };
}

/**
 * Compose the inactive native Windows provider from one accepted existing installation.
 *
 * This function observes and qualifies host artifacts only. It does not register,
 * select, install, or activate MXC and does not call the OpenShell control plane.
 */
export async function attachMxcWindowsExistingInstallation(
  input: MxcWindowsExistingInstallationInput,
): Promise<MxcWindowsExistingInstallationComposition> {
  const boundary = defaultBoundary();
  const hostFacts = boundary.observeHostFacts();
  const assessment = assessWindowsMxcProcessContainerCandidate(hostFacts);
  if (!assessment.candidate) {
    throw new MxcWindowsExistingInstallationError(assessment.detail);
  }

  const attachment = await attachMxcRuntimeProviderBundleFromExistingInstallation({
    hostFacts,
    openshellAttachmentAuthority: input.openshellAttachmentAuthority,
    attachmentObservation: input.attachmentObservation,
    bootstrapControlPlane: input.bootstrapControlPlane,
    observeFileDigest: boundary.observeFileDigest,
  });
  return Object.freeze({ ...attachment, hostFacts: Object.freeze({ ...hostFacts }) });
}
