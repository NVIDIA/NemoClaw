// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MxcWindowsInactiveOnboardingInput } from "../../../src/lib/onboard/windows-mxc/inactive-onboarding.ts";
import { runMxcWindowsInactiveOnboarding } from "../../../src/lib/onboard/windows-mxc/inactive-onboarding.ts";
import {
  qualifyMxcOpenShellAttachment,
  resolveMxcOpenShellDistributionAuthority,
  type MxcOpenShellDistributionAuthority,
} from "../../../src/lib/onboard/runtime-provider/mxc-openshell-attachment.ts";
import {
  observeMxcOpenShellAttachment,
  type MxcOpenShellAttachmentObservationRequest,
} from "../../../src/lib/onboard/runtime-provider/mxc-openshell-observer.ts";
import { createMxcOpenShellRequestScopedControlPlane } from "../../../src/lib/onboard/runtime-provider/mxc-openshell-create-request.ts";
import {
  createMxcOpenShellLiveOperations,
  type MxcOpenShellLiveFailureRecord,
  type MxcOpenShellLivePolicyBinding,
} from "../../../src/lib/onboard/runtime-provider/mxc-openshell-live-operations.ts";
import { createMxcWindowsOpenShellFileDigestObserver } from "../../../src/lib/onboard/runtime-provider/mxc-windows-file-observer.ts";
import {
  createMxcWindowsOpenShellExecutor,
  type MxcWindowsOpenShellExecutorRuntime,
} from "../../../src/lib/onboard/runtime-provider/mxc-windows-openshell-executor.ts";

export interface WindowsMxcInactiveOnboardingCompositionInput {
  readonly distributionAuthority: MxcOpenShellDistributionAuthority;
  readonly attachmentObservation: MxcOpenShellAttachmentObservationRequest;
  readonly gatewayName: string;
  readonly workspace: string;
  readonly policy: MxcOpenShellLivePolicyBinding;
  readonly bootstrap: MxcWindowsInactiveOnboardingInput["bootstrap"];
  readonly executorRuntime?: MxcWindowsOpenShellExecutorRuntime;
  readonly recordFailure?: (record: MxcOpenShellLiveFailureRecord) => void;
}

/**
 * Compose one qualification-only onboarding invocation from the provider-owned distribution,
 * fresh host observation, trusted Windows executor, and request-scoped OpenShell operations.
 */
export async function createWindowsMxcInactiveOnboardingComposition(
  input: WindowsMxcInactiveOnboardingCompositionInput,
): Promise<MxcWindowsInactiveOnboardingInput> {
  const attachmentAuthority = resolveMxcOpenShellDistributionAuthority(input.distributionAuthority);
  const observeFileDigest =
    input.executorRuntime?.observeFileDigest ?? createMxcWindowsOpenShellFileDigestObserver();
  const observation = await observeMxcOpenShellAttachment(
    input.attachmentObservation,
    observeFileDigest,
  );
  const attachment = qualifyMxcOpenShellAttachment(attachmentAuthority, observation);
  const boundary = createMxcWindowsOpenShellExecutor({
    distributionAuthority: input.distributionAuthority,
    observationRequest: input.attachmentObservation,
    runtime: input.executorRuntime,
    recordFailure: input.recordFailure,
  });
  const operations = createMxcOpenShellLiveOperations({
    attachment,
    gatewayName: input.gatewayName,
    workspace: input.workspace,
    policy: input.policy,
    boundary,
  });
  return Object.freeze({
    installation: Object.freeze({
      openshellDistributionAuthority: input.distributionAuthority,
      attachmentObservation: input.attachmentObservation,
      bootstrapControlPlane: createMxcOpenShellRequestScopedControlPlane(operations),
    }),
    bootstrap: input.bootstrap,
  });
}

/** Run the composed qualification path without registering or selecting MXC. */
export async function runWindowsMxcInactiveOnboardingComposition(
  input: WindowsMxcInactiveOnboardingCompositionInput,
) {
  return await runMxcWindowsInactiveOnboarding(
    await createWindowsMxcInactiveOnboardingComposition(input),
  );
}
