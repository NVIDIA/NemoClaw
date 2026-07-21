// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type WebSearchConfig, webSearchProviderForConfig } from "../inference/web-search";
import { filterSetupPolicyPresetNamesForAgent } from "./agent-policy-presets";
import { mergeRequiredHermesToolGatewayPolicyPresets } from "./hermes-managed-tools";
import {
  mergeEnabledMessagingChannelPolicyPresets,
  pruneDisabledMessagingPolicyPresets,
} from "./messaging-policy-presets";
import {
  isInactiveObservabilityPolicyPreset,
  mergeRequiredObservabilityPolicyPresets,
} from "./observability-policy-presets";
import { mergeRequiredOpenclawOtelPolicyPresets } from "./openclaw-otel-policy-presets";
import { classifyPresetProvenance } from "../policy/preset-provenance";
import { filterSuppressedAgentRequiredPresets } from "./policy-tier-suppression";

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
          agentFilteredPresets,
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
  return filterSuppressedAgentRequiredPresets(agentScoped, options.tierName, options.agent);
}

export function isStaleBuiltinBravePolicyPreset(
  name: string,
  options: {
    webSearchConfig?: WebSearchConfig | null;
    customPresetNames?: ReadonlySet<string> | null;
    tierName?: string | null;
    agentName?: string | null;
  } = {},
): boolean {
  return isStaleBuiltinWebSearchPolicyPreset(name, options);
}

export function isStaleBuiltinWebSearchPolicyPreset(
  name: string,
  options: {
    webSearchConfig?: WebSearchConfig | null;
    customPresetNames?: ReadonlySet<string> | null;
    tierName?: string | null;
    agentName?: string | null;
  } = {},
): boolean {
  if (options.customPresetNames?.has(name)) return false;
  // brave/tavily double as a tier's default egress preset (e.g. Brave Search API
  // host access on the Balanced/Open tiers) AND the built-in web-search provider
  // preset. When the preset is a default of the applied tier it is a tier egress
  // default, not a stale web-search leftover — keep it regardless of the web-search
  // provider choice. Reuse the single provenance classifier so pruning and the
  // policy-list display agree on WHY a preset is present, and so the exemption is
  // scoped exactly to the applied tier (Restricted lists no such default → still
  // pruned). classifyPresetProvenance's getTier() returns null for an unknown /
  // non-canonical tier, so this fails safe (unknown → not "tier" → not exempt). (#6844)
  if (
    classifyPresetProvenance(name, {
      tierName: options.tierName,
      agentName: options.agentName,
    }).source === "tier"
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
  return (presetNames, pruning = {}) =>
    pruneDisabledMessagingPolicyPresets(presetNames, options.disabledChannels).filter(
      (name) =>
        (pruning.preserveExplicitWebSearch ||
          !isStaleBuiltinWebSearchPolicyPreset(name, {
            webSearchConfig: options.webSearchConfig,
            customPresetNames: options.customPresetNames,
            tierName: pruning.tierName,
            agentName: options.agent,
          })) &&
        !isInactiveObservabilityPolicyPreset(name, options),
    );
}
