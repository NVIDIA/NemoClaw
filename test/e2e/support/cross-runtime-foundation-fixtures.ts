// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  defineExecutionProfile,
  type ExecutionCapability,
  type ExecutionProfile,
  executionProviderId,
} from "../registry/execution-profile.ts";
import type {
  RuntimeAdapterRegistration,
  RuntimeBindingSpec,
  RuntimeMatrixDefinition,
} from "../registry/runtime-matrix.ts";
import {
  defineRuntimeScenario,
  type RuntimeAgent,
  type RuntimeNeutralScenario,
} from "../registry/scenario.ts";

const COMMON_CAPABILITIES = [
  "agent.configure",
  "agent.turn",
  "evidence.collect",
  "sandbox.lifecycle",
  "state.observe",
] as const satisfies readonly ExecutionCapability[];

export function foundationScenarios(): RuntimeNeutralScenario[] {
  return (["openclaw", "hermes", "dcode"] as const).map((agent) =>
    defineRuntimeScenario({
      id: `${agent}-smoke`,
      agent,
      description: `Runtime-neutral ${agent} lifecycle and turn`,
      journey: [
        { id: "provision", action: "sandbox.provision" },
        { id: "configure", action: "agent.configure" },
        { id: "turn", action: "agent.turn" },
        { id: "observe", action: "state.observe" },
      ],
      requiredCapabilities: [...COMMON_CAPABILITIES],
      assertions: {
        desiredState: {
          agent,
          inference: { model: "fixture-model", provider: "fixture-inference" },
        },
        fsmTrace: [
          { from: "requested", event: "provision", to: "ready" },
          { from: "ready", event: "complete turn", to: "completed" },
        ],
        terminalOutcome: { status: "succeeded", state: "completed" },
        userVisibleState: { status: "ready", response: "fixture response" },
      },
      supportObligations: [
        {
          id: "provision",
          description: "Create and own the isolated sandbox",
          requiredCapabilities: ["sandbox.lifecycle"],
        },
        {
          id: "configure",
          description: "Apply the requested agent configuration",
          requiredCapabilities: ["agent.configure"],
        },
        {
          id: "turn",
          description: "Complete one agent turn",
          requiredCapabilities: ["agent.turn"],
        },
        {
          id: "observe",
          description: "Observe final state and collect evidence",
          requiredCapabilities: ["state.observe", "evidence.collect"],
        },
      ],
    }),
  );
}

export function foundationProfiles(): ExecutionProfile[] {
  return [
    defineExecutionProfile({
      id: "docker-linux-amd64",
      provider: executionProviderId("docker"),
      platform: "linux",
      architecture: "amd64",
      rootMode: "rootful",
      acceleration: "cpu",
      capabilities: [...COMMON_CAPABILITIES, "transport.docker-socket"],
      runner: {
        hostId: "fixture-host",
        label: "fixture-linux",
        maxShards: 2,
      },
    }),
    defineExecutionProfile({
      id: "test-mxc-linux-arm64",
      provider: executionProviderId("test-mxc"),
      platform: "linux",
      architecture: "arm64",
      rootMode: "rootless",
      acceleration: "cpu",
      capabilities: [...COMMON_CAPABILITIES, "transport.socket-free"],
      runner: {
        hostId: "fixture-host",
        label: "fixture-linux",
        maxShards: 2,
      },
    }),
  ];
}

export function obligationBindings(
  scenario: RuntimeNeutralScenario,
  profile: ExecutionProfile,
): RuntimeBindingSpec["obligationBindings"] {
  return scenario.supportObligations.map((obligation) => ({
    obligationId: obligation.id,
    adapterId: `${profile.provider}.${scenario.agent}.${obligation.id}`,
  }));
}

export function foundationBindings(
  scenarios: readonly RuntimeNeutralScenario[],
  profiles: readonly ExecutionProfile[],
): RuntimeBindingSpec[] {
  return scenarios.flatMap((scenario) =>
    profiles.map((profile) => ({
      scenarioId: scenario.id,
      profileId: profile.id,
      obligationBindings: obligationBindings(scenario, profile),
    })),
  );
}

export function foundationAdapterCatalog(
  scenarios: readonly RuntimeNeutralScenario[],
  profiles: readonly ExecutionProfile[],
): RuntimeAdapterRegistration[] {
  const adapters = new Map<string, RuntimeAdapterRegistration>();
  for (const scenario of scenarios) {
    for (const profile of profiles) {
      for (const binding of obligationBindings(scenario, profile)) {
        const adapterId = binding.adapterId;
        adapters.set(binding.adapterId, {
          id: adapterId,
          provider: profile.provider,
          scenarioId: scenario.id,
          obligationId: binding.obligationId,
          execute(runtime, request) {
            return runtime.lifecycle.executeAdapter(adapterId, request);
          },
        });
      }
    }
  }
  return [...adapters.values()];
}

export function foundationDefinition(): RuntimeMatrixDefinition {
  const scenarios = foundationScenarios();
  const profiles = foundationProfiles();
  return {
    scenarios,
    profiles,
    adapterCatalog: foundationAdapterCatalog(scenarios, profiles),
    bindings: foundationBindings(scenarios, profiles),
  };
}

export function scenarioFor(agent: RuntimeAgent): RuntimeNeutralScenario {
  const scenario = foundationScenarios().find((entry) => entry.agent === agent);
  if (!scenario) throw new Error(`Missing fixture scenario for ${agent}`);
  return scenario;
}
