// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { AgentDefinition } from "../agent/defs";
import type { InferenceEndpointSource, InferenceSelection } from "../inference/selection";
import { inferenceSelectionRegistryFields } from "../inference/selection";
import { type WebSearchConfig, webSearchProviderForConfig } from "../inference/web-search";
import * as onboardSession from "../state/onboard-session";
import type { OpenClawImagePluginInstall } from "../state/openclaw-plugin-restore";
import type {
  BaselineExclusionEntry,
  SandboxEntry,
  SandboxMcpState,
  SandboxMessagingState,
} from "../state/registry";
import * as registry from "../state/registry";
import { DEFAULT_TOOL_DISCLOSURE, type ToolDisclosure } from "../tool-disclosure";
import type { DcodeAutoApprovalMode } from "./dcode-auto-approval";
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
  openclawImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
  appliedPolicies: string[];
  toolDisclosure?: ToolDisclosure;
  observabilityEnabled?: boolean;
  dcodeAutoApprovalMode?: DcodeAutoApprovalMode;
  policyTier?: SandboxEntry["policyTier"];
  baselineExclusions?: readonly BaselineExclusionEntry[];
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
  dashboardRemoteBindPrepared?: boolean;
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
  dashboardRemoteBindPrepared?: boolean,
  baselineExclusions?: readonly BaselineExclusionEntry[],
): Pick<
  SandboxEntry,
  | "webSearchEnabled"
  | "webSearchProvider"
  | "fromDockerfile"
  | "hermesAuthMethod"
  | "dashboardRemoteBindPrepared"
  | "baselineExclusions"
> {
  return {
    webSearchEnabled: webSearchConfig?.fetchEnabled === true,
    webSearchProvider: webSearchConfig ? webSearchProviderForConfig(webSearchConfig) : null,
    fromDockerfile,
    hermesAuthMethod,
    dashboardRemoteBindPrepared: dashboardRemoteBindPrepared === true,
    baselineExclusions: baselineExclusions?.map((exclusion) => ({ ...exclusion })),
  };
}

/** Snapshot complete exclusion records before a destructive create removes registry state. */
export function baselineExclusionsForCreate(sandboxName: string): BaselineExclusionEntry[] {
  const transition = registry.getBaselineExclusionTransition(sandboxName);
  if (transition) {
    const key = transition.exclusion.key;
    throw new Error(
      `Baseline policy ${transition.operation} for '${key}' needs repair before sandbox creation. Re-run 'policy ${transition.operation} ${key}' first.`,
    );
  }
  return registry.getBaselineExclusions(sandboxName).map((exclusion) => ({ ...exclusion }));
}

/**
 * Re-read exclusion intent at the destructive create edge and prove it still
 * matches the already-resolved policy plan. The sandbox mutation lock is the
 * caller's serialization boundary; this comparison catches stale plans and
 * any direct registry writer that bypassed that lock.
 */
export function assertBaselineExclusionsMatchCreateIntent(
  sandboxName: string,
  planned: readonly BaselineExclusionEntry[],
): BaselineExclusionEntry[] {
  const current = baselineExclusionsForCreate(sandboxName);
  if (!isDeepStrictEqual(current, [...planned])) {
    throw new Error(
      `Baseline policy exclusions for '${sandboxName}' changed while sandbox creation was being prepared. Retry so the replacement policy uses current registry intent.`,
    );
  }
  return current;
}

export function selection(
  sandboxName: string,
  provider: string,
  model: string,
  preferredInferenceApi: string | null,
  endpointSource: InferenceEndpointSource | null,
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
    endpointSource: sessionMatches ? endpointSource : null,
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
    ...(input.openclawImagePluginInstalls !== undefined
      ? {
          openclawImagePluginInstalls: input.openclawImagePluginInstalls.map((install) => ({
            ...install,
            ...(install.loadPaths !== undefined ? { loadPaths: [...install.loadPaths] } : {}),
          })),
        }
      : {}),
    policies: input.appliedPolicies,
    baselineExclusions: input.baselineExclusions?.map((exclusion) => ({ ...exclusion })),
    toolDisclosure: input.toolDisclosure ?? DEFAULT_TOOL_DISCLOSURE,
    observabilityEnabled: input.observabilityEnabled === true,
    ...(input.dcodeAutoApprovalMode !== undefined
      ? { dcodeAutoApprovalMode: input.dcodeAutoApprovalMode }
      : {}),
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
    dashboardRemoteBindPrepared: input.dashboardRemoteBindPrepared === true,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
  };
}

export function registerCreatedSandbox(input: CreatedSandboxRegistrationInput): SandboxEntry {
  const entry = buildCreatedSandboxRegistryEntry(input);
  (input.registerSandbox ?? registry.registerSandbox)(entry);
  return entry;
}
