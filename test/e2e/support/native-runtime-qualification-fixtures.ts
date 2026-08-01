// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  compileNativeRuntimeQualification,
  NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS,
  NATIVE_RUNTIME_QUALIFICATION_AGENTS,
  NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES,
  NATIVE_RUNTIME_QUALIFICATION_INFERENCE,
  NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS,
  type NativeRuntimeQualificationDefinition,
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

function qualificationProfiles(provider: ExecutionProviderId): ExecutionProfile[] {
  return NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES.flatMap((architecture) =>
    NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS.map((acceleration) =>
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
  const profiles = qualificationProfiles(provider);
  const cases = NATIVE_RUNTIME_QUALIFICATION_AGENTS.flatMap((agent) =>
    profiles.flatMap((profile) =>
      NATIVE_RUNTIME_QUALIFICATION_INFERENCE[profile.acceleration].map((inference) => ({
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
        obligations: [...NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS],
        evidenceKinds: [...requiredQualificationEvidenceKinds(profile.acceleration)],
      })),
    ),
  );
  return {
    id: `${provider}-native-activation`,
    repository: "NVIDIA/NemoClaw",
    provider,
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
