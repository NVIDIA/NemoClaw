// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { projectRuntimeProviderComputePlan, type OpenShellComputePlan } from "../compute/plan";
import type {
  RuntimeProviderBundle,
  RuntimeProviderNativeArtifactBootstrapInput,
  RuntimeProviderNativeArtifactBootstrapResult,
  RuntimeProviderNativeArtifactBootstrapSurface,
} from "../runtime-provider/contract";
import type { MxcOpenShellAttachmentReceipt } from "../runtime-provider/mxc-openshell-attachment";
import {
  attachMxcWindowsExistingInstallation,
  type MxcWindowsExistingInstallationInput,
} from "./existing-installation";
import type { WindowsMxcHostFacts } from "./host-qualification";

const PROVIDER_ID = "mxc" as const;

export type MxcWindowsInactiveOnboardingBootstrapInput = Omit<
  RuntimeProviderNativeArtifactBootstrapInput,
  "providerId"
>;

export interface MxcWindowsInactiveOnboardingInput {
  readonly installation: MxcWindowsExistingInstallationInput;
  readonly bootstrap: MxcWindowsInactiveOnboardingBootstrapInput;
}

export interface MxcWindowsInactiveOnboardingResult {
  readonly provider: RuntimeProviderBundle;
  readonly computePlan: OpenShellComputePlan;
  readonly attachmentReceipt: MxcOpenShellAttachmentReceipt;
  readonly hostFacts: WindowsMxcHostFacts;
  readonly bootstrapResult: RuntimeProviderNativeArtifactBootstrapResult;
}

export class MxcWindowsInactiveOnboardingError extends Error {
  constructor(message: string) {
    super(`Inactive Windows OpenShell MXC onboarding failed: ${message}`);
    this.name = "MxcWindowsInactiveOnboardingError";
  }
}

function requireNativeArtifactBootstrap(
  provider: RuntimeProviderBundle,
): RuntimeProviderNativeArtifactBootstrapSurface {
  if (
    !provider.bootstrap.supported ||
    provider.bootstrap.providerId !== PROVIDER_ID ||
    provider.bootstrap.bootstrapKind !== "native-artifact"
  ) {
    throw new MxcWindowsInactiveOnboardingError(
      "the attached provider does not expose the accepted native-artifact bootstrap contract",
    );
  }
  return provider.bootstrap;
}

async function execute(
  input: MxcWindowsInactiveOnboardingInput,
  operation: "run" | "recover",
): Promise<MxcWindowsInactiveOnboardingResult> {
  const attachment = await attachMxcWindowsExistingInstallation(input.installation);
  if (!attachment.provider.workload.supported) {
    throw new MxcWindowsInactiveOnboardingError(
      "the attached provider does not expose a workload contract",
    );
  }
  if (!attachment.provider.workload.acceptsReceipt(input.bootstrap.workload)) {
    throw new MxcWindowsInactiveOnboardingError(
      "the native artifact does not match the attached provider workload contract",
    );
  }
  const bootstrap = requireNativeArtifactBootstrap(attachment.provider);
  const bootstrapResult = await bootstrap[operation]({
    ...input.bootstrap,
    providerId: PROVIDER_ID,
  });
  return Object.freeze({
    provider: attachment.provider,
    computePlan: Object.freeze(projectRuntimeProviderComputePlan(attachment.provider)),
    attachmentReceipt: attachment.attachmentReceipt,
    hostFacts: attachment.hostFacts,
    bootstrapResult,
  });
}

/**
 * Exercise the inactive native Windows onboarding path without registering or selecting MXC.
 *
 * The existing installation is observed once during attachment and again immediately before the
 * provider-owned atomic verify-and-create operation.
 */
export function runMxcWindowsInactiveOnboarding(
  input: MxcWindowsInactiveOnboardingInput,
): Promise<MxcWindowsInactiveOnboardingResult> {
  return execute(input, "run");
}

/** Reconcile one prior inactive bootstrap attempt after requalifying the existing installation. */
export function recoverMxcWindowsInactiveOnboarding(
  input: MxcWindowsInactiveOnboardingInput,
): Promise<MxcWindowsInactiveOnboardingResult> {
  return execute(input, "recover");
}
