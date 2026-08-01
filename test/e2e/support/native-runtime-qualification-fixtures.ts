// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineRuntimeProviderActivationDeclaration } from "../../../src/lib/onboard/runtime-provider/activation.ts";
import {
  compileNativeRuntimeQualification,
  type NativeRuntimeQualificationDefinition,
  type NativeRuntimeQualificationScope,
  nativeRuntimeQualificationScope,
  qualificationCaseId,
  requiredQualificationEvidenceKinds,
} from "../registry/activation-qualification.ts";
import {
  defineExecutionProfile,
  type ExecutionAcceleration,
  type ExecutionArchitecture,
  type ExecutionProfile,
  type ExecutionProviderId,
  executionProviderId,
} from "../registry/execution-profile.ts";

const QUALIFICATION_CAPABILITIES = [
  "agent.configure",
  "agent.turn",
  "evidence.collect",
  "sandbox.lifecycle",
  "state.observe",
  "transport.socket-free",
] as const;

function profileId(
  provider: ExecutionProviderId,
  architecture: ExecutionArchitecture,
  acceleration: ExecutionAcceleration,
): string {
  return `${provider}-linux-${architecture}-${acceleration}`;
}

function qualificationProfiles(
  provider: ExecutionProviderId,
  scope: NativeRuntimeQualificationScope,
): ExecutionProfile[] {
  return scope.architectures.flatMap((architecture) =>
    scope.accelerations.map((acceleration) =>
      defineExecutionProfile({
        id: profileId(provider, architecture, acceleration),
        provider,
        platform: "linux",
        architecture,
        rootMode: "rootless",
        acceleration,
        capabilities: [...QUALIFICATION_CAPABILITIES],
        runner: {
          hostId: `protected-${architecture}-${acceleration}`,
          label: `protected Linux ${architecture} ${acceleration}`,
          maxShards: 1,
        },
      }),
    ),
  );
}

export function nativeRuntimeQualificationDefinition(
  providerName: string,
): NativeRuntimeQualificationDefinition {
  const provider = executionProviderId(providerName);
  const activation = defineRuntimeProviderActivationDeclaration(provider);
  const scope = nativeRuntimeQualificationScope(activation);
  const profiles = qualificationProfiles(provider, scope);
  const cases = scope.agents.flatMap((agent) =>
    profiles.flatMap((profile) =>
      scope.inference[profile.acceleration].map((inference) => ({
        id: qualificationCaseId({
          provider,
          agent,
          architecture: profile.architecture,
          acceleration: profile.acceleration,
          inference,
        }),
        agent,
        profile,
        inference,
        gate: "protected-e2e" as const,
        install: "release-installer" as const,
        dockerAvailability: "unavailable" as const,
        obligations: [...scope.obligations],
        evidenceKinds: [...requiredQualificationEvidenceKinds(profile.acceleration)],
      })),
    ),
  );
  return {
    id: `${provider}-native-activation`,
    repository: "NVIDIA/NemoClaw",
    protectedWorkflow: "E2E / PR Gate",
    provider,
    activation,
    cases,
  };
}

/**
 * Dormant candidate contract. Importing this fixture compiles scope; it does
 * not register a production runtime, a canonical live target, or a workflow.
 */
export const PODMAN_NATIVE_ACTIVATION_QUALIFICATION = compileNativeRuntimeQualification(
  nativeRuntimeQualificationDefinition("podman"),
);
