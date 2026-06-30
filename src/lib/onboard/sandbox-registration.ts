// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import type { InferenceSelection } from "../inference/selection";
import { inferenceSelectionRegistryFields } from "../inference/selection";
import * as onboardSession from "../state/onboard-session";
import type { SandboxEntry, SandboxMessagingState } from "../state/registry";
import * as registry from "../state/registry";
import {
  getHermesDashboardRegistryFields,
  type HermesDashboardOnboardState,
} from "./hermes-dashboard";
import { getSandboxAgentRegistryFields } from "./sandbox-agent";

export type CreatedSandboxRuntimeFields = Pick<
  SandboxEntry,
  | "gpuEnabled"
  | "hostGpuDetected"
  | "sandboxGpuEnabled"
  | "sandboxGpuMode"
  | "sandboxGpuDevice"
  | "sandboxGpuProof"
  | "openshellDriver"
  | "openshellVersion"
>;

export interface CreatedSandboxRegistryEntryInput {
  sandboxName: string;
  inferenceSelection: InferenceSelection;
  runtimeFields: CreatedSandboxRuntimeFields;
  agent: AgentDefinition | null | undefined;
  agentVersionKnown: boolean;
  imageTag: string | null;
  appliedPolicies: string[];
  plannedMessagingState: SandboxMessagingState | undefined;
  hermesToolGateways: string[];
  hermesDashboardState: HermesDashboardOnboardState;
  dashboardPort: number;
  gatewayName: string;
  gatewayPort: number;
}

export interface CreatedSandboxRegistrationInput extends CreatedSandboxRegistryEntryInput {
  registerSandbox?(entry: SandboxEntry): void;
}

export function selection(
  sandboxName: string,
  provider: string,
  model: string,
  preferredInferenceApi: string | null,
): InferenceSelection {
  const session = onboardSession.loadSession();
  const sessionMatches =
    session?.sandboxName === sandboxName &&
    session.provider === provider &&
    session.model === model;
  return inferenceSelectionRegistryFields({
    provider,
    model,
    endpointUrl: sessionMatches ? (session.endpointUrl ?? null) : null,
    credentialEnv: sessionMatches ? (session.credentialEnv ?? null) : null,
    preferredInferenceApi,
    nimContainer: sessionMatches ? (session.nimContainer ?? null) : null,
  });
}

export function buildCreatedSandboxRegistryEntry(
  input: CreatedSandboxRegistryEntryInput,
): SandboxEntry {
  const messagingState =
    input.plannedMessagingState?.plan.sandboxName === input.sandboxName
      ? input.plannedMessagingState
      : undefined;

  return {
    name: input.sandboxName,
    ...inferenceSelectionRegistryFields(input.inferenceSelection),
    ...input.runtimeFields,
    ...getSandboxAgentRegistryFields(input.agent, input.agentVersionKnown),
    imageTag: input.imageTag,
    policies: input.appliedPolicies,
    messaging: messagingState,
    hermesToolGateways:
      input.hermesToolGateways.length > 0 ? [...input.hermesToolGateways] : undefined,
    ...getHermesDashboardRegistryFields(input.hermesDashboardState),
    dashboardPort: input.dashboardPort,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
  };
}

export function registerCreatedSandbox(input: CreatedSandboxRegistrationInput): SandboxEntry {
  const entry = buildCreatedSandboxRegistryEntry(input);
  (input.registerSandbox ?? registry.registerSandbox)(entry);
  return entry;
}
