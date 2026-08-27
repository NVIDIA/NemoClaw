// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import type { BaselineExclusionEntry } from "../state/registry";
import type { DockerGpuRoutePlan } from "./docker-gpu-route";
import type { NamedMessagingChannel } from "./messaging-prep";
import {
  resolvePrimaryMessagingCredentialEnvKeys,
  resolveSandboxCreateIntent,
  resolveSandboxCreateMessagingProviderRequests,
} from "./sandbox-create-intent";
import type { SandboxCreateIntent } from "./sandbox-create-intent-types";
import { getActiveChannelsFromPlan } from "./messaging-plan-session";
import { resolveSandboxCreatePolicyTier } from "./sandbox-create-plan";
import {
  selectHermesPortableExtraProviderPlan,
  selectHermesPortableMessagingCapabilities,
  validateSandboxCreateIntentBindings,
} from "./sandbox-create-plan-materialization";
import { buildSandboxGpuCreateArgs, type SandboxGpuCreateConfig } from "./sandbox-gpu-create";
import {
  prepareSandboxMessagingPreflight,
  type SandboxMessagingPreflightDeps,
} from "./sandbox-messaging-preflight";

export type CompleteSandboxCreateIntentInput<Agent, ResourceProfile> = {
  sandboxName: string;
  inferenceProvider?: string | null;
  hostLocalInferenceRouteOnly?: boolean;
  enabledChannels: readonly string[] | null;
  webSearchConfig: WebSearchConfig | null;
  agent: Agent;
  sandboxGpuConfig: SandboxGpuCreateConfig;
  resourceProfile: ResourceProfile | null;
  hostMounts?: readonly import("../state/registry/types").SandboxHostMount[];
  hermesToolGateways: readonly string[];
  extraProviders: readonly string[];
  staleExtraProviders: readonly string[];
  policyTier?: string | null;
  /** Operator baseline exclusions replayed into create/rebuild policy generation. */
  baselineExclusions?: readonly BaselineExclusionEntry[];
  /** Internal OpenClaw resume authority for exact registered provider reuse. */
  reuseRegisteredCredentials?: boolean;
};

export interface SandboxCreateIntentResolverDeps<Agent, ResourceProfile> {
  channels: readonly NamedMessagingChannel[];
  messagingPreflightDeps: SandboxMessagingPreflightDeps;
  filterEnabledChannelsByAgent(enabledChannels: string[] | null, agent: Agent): string[] | null;
  defaultPolicyPath: string;
  getAgentPolicyPath(agent: Agent): string | null;
  resolveGpuPlan(
    config: SandboxGpuCreateConfig,
    agent: Agent,
  ): {
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

  function resolveSelectedChannels(
    input: Pick<
      CompleteSandboxCreateIntentInput<Agent, ResourceProfile>,
      "sandboxName" | "enabledChannels" | "agent"
    >,
  ): string[] | null {
    const selected = filterEnabledChannels(input.enabledChannels, input.agent);
    if (selected !== null) return selected;
    const stagedPlan = deps.messagingPreflightDeps.readMessagingPlanFromEnv();
    if (stagedPlan?.sandboxName === input.sandboxName) {
      return filterEnabledChannels(getActiveChannelsFromPlan(stagedPlan), input.agent) ?? [];
    }
    const agentName = input.agent?.name?.trim().toLowerCase();
    return agentName && agentName !== "openclaw" ? null : [];
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
        enabledChannels: resolveSelectedChannels(input),
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
      input.agent,
    );
    const resourceCreateArgs: string[] = [];
    deps.appendResourceCreateArgs(resourceCreateArgs, input.resourceProfile);
    return resolveSandboxCreateIntent({
      basePolicyPath: deps.getAgentPolicyPath(input.agent) || deps.defaultPolicyPath,
      sandboxName: input.sandboxName,
      inferenceProvider: input.inferenceProvider,
      hostLocalInferenceRouteOnly: input.hostLocalInferenceRouteOnly === true,
      channels: deps.channels,
      enabledChannels: resolveSelectedChannels(input),
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
      hostMounts: input.hostMounts,
      gpuRoutePlan,
      sandboxGpuLogMessage,
      extraPlaceholderKeys: messaging.extraPlaceholderKeys,
      agentName: input.agent?.name,
      policyTier: resolveSandboxCreatePolicyTier(input.policyTier),
      baselineExclusions: input.baselineExclusions,
    });
  }

  async function resolvePortableLifecycle(
    input: Omit<
      CompleteSandboxCreateIntentInput<Agent, ResourceProfile>,
      "extraProviders" | "staleExtraProviders"
    >,
    options: {
      readonly hermesPortable: boolean;
      readonly requestedExtraProviders?: readonly string[];
      readonly resolvedIntent?: SandboxCreateIntent;
      readonly planOrdinaryExtraProviders: () => {
        readonly extraProviders: readonly string[];
        readonly staleExtraProviders: readonly string[];
      };
    },
  ) {
    const extraProviderPlan = selectHermesPortableExtraProviderPlan(
      options.hermesPortable,
      options.requestedExtraProviders,
      options.planOrdinaryExtraProviders,
    );
    const intent =
      options.resolvedIntent ??
      (await resolve({
        ...input,
        extraProviders: extraProviderPlan.extraProviders,
        staleExtraProviders: extraProviderPlan.staleExtraProviders,
      }));
    const messagingCapabilities = await selectHermesPortableMessagingCapabilities(
      options.hermesPortable,
      () => prepareMessagingCapabilities(input, intent),
    );
    return { intent, messagingCapabilities };
  }

  return {
    resolve,
    resolvePortableLifecycle,
    rebind: prepareMessagingCapabilities,
    prepareCredentialProviders: (
      input: Pick<
        CompleteSandboxCreateIntentInput<Agent, ResourceProfile>,
        "sandboxName" | "enabledChannels" | "webSearchConfig" | "agent"
      >,
    ) => prepareMessagingCapabilities(input, undefined, true),
  };
}
