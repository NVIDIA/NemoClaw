// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type WebSearchConfig, webSearchProviderForConfig } from "../inference/web-search";
import {
  filterSetupPolicyPresetNamesForAgent,
  setupPolicyPresetAppliesToAgent,
} from "./agent-policy-presets";
import { mergeRequiredHermesToolGatewayPolicyPresets } from "./hermes-managed-tools";
import {
  mergeEnabledMessagingChannelPolicyPresets,
  pruneDisabledMessagingPolicyPresets,
  pruneInactiveMessagingPolicyPresets,
} from "./messaging-policy-presets";
import {
  isInactiveObservabilityPolicyPreset,
  mergeRequiredObservabilityPolicyPresets,
} from "./observability-policy-presets";
import { mergeRequiredOpenclawOtelPolicyPresets } from "./openclaw-otel-policy-presets";
import { getTier, type TierDefinition } from "../policy/tiers";
import {
  ensureRequiredTierPolicyPresets,
  filterSuppressedAgentRequiredPresets,
} from "./policy-tier-suppression";

export type RequiredSetupPolicyPresetOptions = {
  enabledChannels?: string[] | null;
  hermesToolGateways?: string[] | null;
  agent?: string | null;
  observabilityEnabled?: boolean | null;
  knownPresetNames?: string[] | Set<string> | null;
  env?: NodeJS.ProcessEnv;
  tierName?: string | null;
  webSearchConfig?: WebSearchConfig | null;
  customPresetNames?: ReadonlySet<string> | null;
  customOwnsObservability?: boolean;
};

export function mergeRequiredSetupPolicyPresets(
  policyPresets: string[],
  options: RequiredSetupPolicyPresetOptions = {},
): string[] {
  const agentFilteredPresets = filterSetupPolicyPresetNamesForAgent(
    policyPresets,
    options.agent,
  ).filter(
    (name) =>
      !isInactiveObservabilityPolicyPreset(name, {
        agent: options.agent,
        observabilityEnabled: options.observabilityEnabled,
        customPresetNames: options.customPresetNames,
        customOwnsObservability: options.customOwnsObservability,
      }),
  );
  const activeAgentPresets = pruneInactiveMessagingPolicyPresets(
    agentFilteredPresets,
    options.enabledChannels,
    options.customPresetNames,
  );
  const effectiveHermesToolGateways = (options.hermesToolGateways ?? []).filter(
    (name) =>
      !isStaleBuiltinWebSearchPolicyPreset(name, {
        webSearchConfig: options.webSearchConfig,
        customPresetNames: options.customPresetNames,
      }),
  );
  const mergedPresets = mergeRequiredObservabilityPolicyPresets(
    mergeRequiredOpenclawOtelPolicyPresets(
      mergeEnabledMessagingChannelPolicyPresets(
        mergeRequiredHermesToolGatewayPolicyPresets(
          activeAgentPresets,
          effectiveHermesToolGateways,
          options.knownPresetNames,
        ),
        options.enabledChannels,
        options.knownPresetNames,
      ),
      {
        agent: options.agent,
        knownPresetNames: options.knownPresetNames,
        env: options.env,
      },
    ),
    {
      agent: options.agent,
      observabilityEnabled: options.observabilityEnabled,
      knownPresetNames: options.knownPresetNames,
      customOwnsObservability: options.customOwnsObservability,
    },
  );
  const agentScoped = filterSetupPolicyPresetNamesForAgent(mergedPresets, options.agent);
  return ensureRequiredTierPolicyPresets(
    options.tierName,
    filterSuppressedAgentRequiredPresets(agentScoped, options.tierName, options.agent),
  );
}

export function isStaleBuiltinWebSearchPolicyPreset(
  name: string,
  options: {
    webSearchConfig?: WebSearchConfig | null;
    customPresetNames?: ReadonlySet<string> | null;
    tier?: TierDefinition | null;
    agent?: string | null;
  } = {},
): boolean {
  if (options.customPresetNames?.has(name)) return false;
  // A preset in the recorded tier is tier egress, not stale provider state.
  // Unknown tiers fail closed because the canonical tier lookup returns no match.
  if (
    setupPolicyPresetAppliesToAgent(name, options.agent) &&
    options.tier?.presets.some(
      (preset) => preset.name.trim().toLowerCase() === name.trim().toLowerCase(),
    )
  ) {
    return false;
  }
  if (name === "nous-web") {
    return Boolean(
      options.webSearchConfig && webSearchProviderForConfig(options.webSearchConfig) === "tavily",
    );
  }
  if (name !== "brave" && name !== "tavily") return false;
  if (!options.webSearchConfig) return true;
  return name !== webSearchProviderForConfig(options.webSearchConfig);
}

export function createUnavailablePolicyPresetPruner(options: {
  disabledChannels?: string[] | null;
  enabledChannels?: string[] | null;
  agent?: string | null;
  observabilityEnabled?: boolean | null;
  webSearchConfig?: WebSearchConfig | null;
  customPresetNames?: ReadonlySet<string> | null;
  customOwnsObservability?: boolean;
}): (
  presetNames: string[],
  pruning?: {
    preserveExplicitWebSearch?: boolean;
    tierName?: string | null;
  },
) => string[] {
  // Custom and interactive selections may explicitly opt into a built-in web-search
  // preset without storing provider config. Inactive observability remains ineligible.
  return (presetNames, pruning = {}) => {
    const tierName = pruning.tierName?.trim().toLowerCase();
    const tier = tierName ? getTier(tierName) : null;
    // OpenClaw keeps an already-applied channel preset until disabledChannels
    // explicitly retires it. Hermes recovery records the full enabled set, so
    // it can also prune repository defaults that are absent from that set.
    const enabledChannelPruned =
      options.agent?.trim().toLowerCase() === "hermes"
        ? pruneInactiveMessagingPolicyPresets(
            pruneDisabledMessagingPolicyPresets(presetNames, options.disabledChannels),
            options.enabledChannels,
            options.customPresetNames,
          )
        : pruneDisabledMessagingPolicyPresets(presetNames, options.disabledChannels);
    return enabledChannelPruned.filter(
      (name) =>
        (pruning.preserveExplicitWebSearch ||
          !isStaleBuiltinWebSearchPolicyPreset(name, {
            webSearchConfig: options.webSearchConfig,
            customPresetNames: options.customPresetNames,
            tier,
            agent: options.agent,
          })) &&
        !isInactiveObservabilityPolicyPreset(name, options),
    );
  };
}
