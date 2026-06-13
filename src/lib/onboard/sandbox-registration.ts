// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
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
  model: string;
  provider: string;
  runtimeFields: CreatedSandboxRuntimeFields;
  agent: AgentDefinition | null | undefined;
  agentVersionKnown: boolean;
  imageTag: string | null;
  providerCredentialHashes: Record<string, string>;
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

export function buildCreatedSandboxRegistryEntry(
  input: CreatedSandboxRegistryEntryInput,
): SandboxEntry {
  const messagingState =
    input.plannedMessagingState?.plan.sandboxName === input.sandboxName
      ? input.plannedMessagingState
      : undefined;

  return {
    name: input.sandboxName,
    model: input.model || null,
    provider: input.provider || null,
    ...input.runtimeFields,
    ...getSandboxAgentRegistryFields(input.agent, input.agentVersionKnown),
    imageTag: input.imageTag,
    providerCredentialHashes:
      Object.keys(input.providerCredentialHashes).length > 0
        ? input.providerCredentialHashes
        : undefined,
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
