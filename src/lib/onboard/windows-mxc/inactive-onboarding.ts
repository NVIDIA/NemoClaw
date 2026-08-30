// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellComputePlan } from "../compute/plan";
import type {
  RuntimeProviderBundle,
  RuntimeProviderNativeArtifactBootstrapResult,
} from "../runtime-provider/contract";
import type { MxcOpenShellAttachmentReceipt } from "../runtime-provider/mxc-openshell-attachment";
import {
  recoverInactiveNativeArtifactOnboarding,
  runInactiveNativeArtifactOnboarding,
  type InactiveNativeArtifactOnboardingBootstrapInput,
} from "../runtime-provider/native-artifact-onboarding";
import {
  attachMxcWindowsExistingInstallation,
  type MxcWindowsExistingInstallationInput,
} from "./existing-installation";
import type { WindowsMxcHostFacts } from "./host-qualification";

export type MxcWindowsInactiveOnboardingBootstrapInput =
  InactiveNativeArtifactOnboardingBootstrapInput;

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

async function execute(
  input: MxcWindowsInactiveOnboardingInput,
  operation: "run" | "recover",
): Promise<MxcWindowsInactiveOnboardingResult> {
  const attachment = await attachMxcWindowsExistingInstallation(input.installation);
  const onboarding = await (
    operation === "run"
      ? runInactiveNativeArtifactOnboarding
      : recoverInactiveNativeArtifactOnboarding
  )({
    provider: attachment.provider,
    bootstrap: input.bootstrap,
  });
  return Object.freeze({
    provider: onboarding.provider,
    computePlan: onboarding.computePlan,
    attachmentReceipt: attachment.attachmentReceipt,
    hostFacts: attachment.hostFacts,
    bootstrapResult: onboarding.bootstrapResult,
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
