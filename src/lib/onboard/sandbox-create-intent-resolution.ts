// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import type { DockerGpuRoutePlan } from "./docker-gpu-route";
import type { NamedMessagingChannel } from "./messaging-prep";
import {
  resolvePrimaryMessagingCredentialEnvKeys,
  resolveSandboxCreateIntent,
  resolveSandboxCreateMessagingProviderRequests,
} from "./sandbox-create-intent";
import type { SandboxCreateIntent } from "./sandbox-create-intent-types";
import { resolveSandboxCreatePolicyTier } from "./sandbox-create-plan";
import { validateSandboxCreateIntentBindings } from "./sandbox-create-plan-materialization";
import { buildSandboxGpuCreateArgs, type SandboxGpuCreateConfig } from "./sandbox-gpu-create";
import {
  prepareSandboxMessagingPreflight,
  type SandboxMessagingPreflightDeps,
} from "./sandbox-messaging-preflight";

export type CompleteSandboxCreateIntentInput<Agent, ResourceProfile> = {
  sandboxName: string;
  enabledChannels: readonly string[] | null;
  webSearchConfig: WebSearchConfig | null;
  agent: Agent;
  sandboxGpuConfig: SandboxGpuCreateConfig;
  resourceProfile: ResourceProfile | null;
  hermesToolGateways: readonly string[];
  extraProviders: readonly string[];
  staleExtraProviders: readonly string[];
  policyTier?: string | null;
  /** Internal OpenClaw resume authority for exact registered provider reuse. */
  reuseRegisteredCredentials?: boolean;
};

export interface SandboxCreateIntentResolverDeps<Agent, ResourceProfile> {
  channels: readonly NamedMessagingChannel[];
  messagingPreflightDeps: SandboxMessagingPreflightDeps;
  filterEnabledChannelsByAgent(enabledChannels: string[] | null, agent: Agent): string[] | null;
  defaultPolicyPath: string;
  getAgentPolicyPath(agent: Agent): string | null;
  resolveGpuPlan(config: SandboxGpuCreateConfig): {
    gpuRoutePlan: DockerGpuRoutePlan;
    logMessage: string | null;
  };
  appendResourceCreateArgs(args: string[], resourceProfile: ResourceProfile | null): void;
}

export function createSandboxCreateIntentResolver<
  Agent extends { name?: string | null } | null,
  ResourceProfile,
>(deps: SandboxCreateIntentResolverDeps<Agent, ResourceProfile>) {
  function filterEnabledChannels(enabledChannels: readonly string[] | null, agent: Agent) {
    return deps.filterEnabledChannelsByAgent(enabledChannels ? [...enabledChannels] : null, agent);
  }

  async function prepareMessagingCapabilities(
    input: Pick<
      CompleteSandboxCreateIntentInput<Agent, ResourceProfile>,
      "sandboxName" | "enabledChannels" | "webSearchConfig" | "agent" | "reuseRegisteredCredentials"
    >,
    expectedIntent?: SandboxCreateIntent,
    credentialRegistration = false,
  ) {
    const preflightDeps = expectedIntent
      ? {
          ...deps.messagingPreflightDeps,
          readMessagingPlanFromEnv: () => null,
          resolveDisabledChannels: () => [...expectedIntent.disabledChannelNames],
        }
      : credentialRegistration
        ? {
            ...deps.messagingPreflightDeps,
            readMessagingPlanFromEnv: () => null,
            registerExtraPlaceholderProviders: () => [],
          }
        : deps.messagingPreflightDeps;
    const result = await prepareSandboxMessagingPreflight(
      {
        channels: deps.channels,
        enabledChannels: filterEnabledChannels(input.enabledChannels, input.agent),
        sandboxName: input.sandboxName,
        agentName: input.agent?.name ?? "openclaw",
        requireExactProviderBinding:
          credentialRegistration || input.reuseRegisteredCredentials === true,
        webSearchConfig: input.webSearchConfig,
        env: process.env,
      },
      preflightDeps,
    );
    if (expectedIntent) {
      validateSandboxCreateIntentBindings(expectedIntent, result.messagingTokenDefs);
      if (
        JSON.stringify(result.reusableMessagingProviders) !==
          JSON.stringify(expectedIntent.reusableMessagingProviders) ||
        JSON.stringify(result.extraPlaceholderKeys) !==
          JSON.stringify(expectedIntent.extraPlaceholderKeys)
      ) {
        throw new Error(
          "Cannot materialize sandbox create intent; messaging capabilities changed.",
        );
      }
    }
    return result;
  }

  async function resolve(
    input: CompleteSandboxCreateIntentInput<Agent, ResourceProfile>,
  ): Promise<SandboxCreateIntent> {
    const messaging = await prepareMessagingCapabilities(input);
    const { gpuRoutePlan, logMessage: sandboxGpuLogMessage } = deps.resolveGpuPlan(
      input.sandboxGpuConfig,
    );
    const resourceCreateArgs: string[] = [];
    deps.appendResourceCreateArgs(resourceCreateArgs, input.resourceProfile);
    return resolveSandboxCreateIntent({
      basePolicyPath: deps.getAgentPolicyPath(input.agent) || deps.defaultPolicyPath,
      sandboxName: input.sandboxName,
      channels: deps.channels,
      enabledChannels: filterEnabledChannels(input.enabledChannels, input.agent),
      disabledChannelNames: messaging.disabledChannelNames,
      messagingProviderRequests: resolveSandboxCreateMessagingProviderRequests(
        messaging.messagingTokenDefs,
        deps.messagingPreflightDeps.getMessagingChannelForEnvKey,
      ),
      primaryMessagingCredentialEnvKeys: resolvePrimaryMessagingCredentialEnvKeys(),
      reusableMessagingChannels: messaging.reusableMessagingChannels,
      reusableMessagingProviders: messaging.reusableMessagingProviders,
      extraProviders: input.extraProviders,
      staleExtraProviders: input.staleExtraProviders,
      hermesToolGateways: input.hermesToolGateways,
      sandboxGpuConfig: input.sandboxGpuConfig,
      gpuCreateArgs: buildSandboxGpuCreateArgs(input.sandboxGpuConfig),
      resourceCreateArgs,
      gpuRoutePlan,
      sandboxGpuLogMessage,
      extraPlaceholderKeys: messaging.extraPlaceholderKeys,
      agentName: input.agent?.name,
      policyTier: resolveSandboxCreatePolicyTier(input.policyTier),
    });
  }

  return {
    resolve,
    rebind: prepareMessagingCapabilities,
    prepareCredentialProviders: (
      input: Pick<
        CompleteSandboxCreateIntentInput<Agent, ResourceProfile>,
        "sandboxName" | "enabledChannels" | "webSearchConfig" | "agent"
      >,
    ) => prepareMessagingCapabilities(input, undefined, true),
  };
}
