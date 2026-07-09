// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import type { InferenceSelection } from "../inference/selection";
import { inferenceSelectionRegistryFields } from "../inference/selection";
import { type WebSearchConfig, webSearchProviderForConfig } from "../inference/web-search";
import { fingerprintRebuildReplacement } from "../rebuild-correlation";
import * as onboardSession from "../state/onboard-session";
import type { SandboxEntry, SandboxMcpState, SandboxMessagingState } from "../state/registry";
import * as registry from "../state/registry";
import { DEFAULT_TOOL_DISCLOSURE, type ToolDisclosure } from "../tool-disclosure";
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
  toolDisclosure?: ToolDisclosure;
  observabilityEnabled?: boolean;
  policyTier?: SandboxEntry["policyTier"];
  webSearchEnabled?: boolean;
  webSearchProvider?: SandboxEntry["webSearchProvider"];
  fromDockerfile?: string | null;
  hermesAuthMethod?: "oauth" | "api_key" | null;
  plannedMessagingState: SandboxMessagingState | undefined;
  /**
   * Durable MCP rebuild manifest carried across an already-absent sandbox.
   * The caller must only supply state captured from the same sandbox name.
   */
  preservedMcpState?: SandboxMcpState;
  hermesToolGateways: string[];
  hermesDashboardState: HermesDashboardOnboardState;
  dashboardPort: number;
  gatewayName: string;
  gatewayPort: number;
}

export interface CreatedSandboxRegistrationInput extends CreatedSandboxRegistryEntryInput {
  registerSandbox?(entry: SandboxEntry): void;
}

export function creationFidelity(
  webSearchConfig: WebSearchConfig | null,
  fromDockerfile: string | null,
  hermesAuthMethod: "oauth" | "api_key" | null,
): Pick<
  SandboxEntry,
  "webSearchEnabled" | "webSearchProvider" | "fromDockerfile" | "hermesAuthMethod"
> {
  return {
    webSearchEnabled: webSearchConfig?.fetchEnabled === true,
    webSearchProvider: webSearchConfig ? webSearchProviderForConfig(webSearchConfig) : null,
    fromDockerfile,
    hermesAuthMethod,
  };
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
    compatibleEndpointReasoning: sessionMatches
      ? (session.compatibleEndpointReasoning ?? null)
      : null,
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
    toolDisclosure: input.toolDisclosure ?? DEFAULT_TOOL_DISCLOSURE,
    observabilityEnabled: input.observabilityEnabled === true,
    ...(input.policyTier !== undefined ? { policyTier: input.policyTier } : {}),
    webSearchEnabled: input.webSearchEnabled === true,
    webSearchProvider:
      input.webSearchEnabled === true ? (input.webSearchProvider ?? "brave") : null,
    fromDockerfile: input.fromDockerfile ?? null,
    hermesAuthMethod: input.hermesAuthMethod ?? null,
    messaging: messagingState,
    mcp: input.preservedMcpState,
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
  recordCreatedRebuildReplacement(entry);
  return entry;
}

function recordCreatedRebuildReplacement(entry: SandboxEntry): void {
  const session = onboardSession.loadSession();
  const correlation = session?.metadata.rebuild;
  if (!correlation || session.sandboxName !== entry.name) return;

  // OpenShell currently exposes name/readiness but no structured image/build
  // identity. The registry row plus transaction-owned session are therefore the
  // local proof used after a create-before-receipt crash. A missing or divergent
  // half fails closed. Replace this dual-file anchor when OpenShell exposes an
  // authoritative replacement identity API.
  const replacementFingerprint = fingerprintRebuildReplacement(entry);
  onboardSession.updateSession((current) => {
    const currentCorrelation = current.metadata.rebuild;
    if (
      current.sandboxName === entry.name &&
      currentCorrelation?.transactionId === correlation.transactionId
    ) {
      current.metadata.rebuild = { ...currentCorrelation, replacementFingerprint };
    }
    return current;
  });
}
