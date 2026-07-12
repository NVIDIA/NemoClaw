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
  } = {},
): boolean {
  return isStaleBuiltinWebSearchPolicyPreset(name, options);
}

export function isStaleBuiltinWebSearchPolicyPreset(
  name: string,
  options: {
    webSearchConfig?: WebSearchConfig | null;
    customPresetNames?: ReadonlySet<string> | null;
  } = {},
): boolean {
  if (options.customPresetNames?.has(name)) return false;
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
}): (presetNames: string[], pruning?: { preserveExplicitWebSearch?: boolean }) => string[] {
  // Custom and interactive selections may explicitly opt into a built-in web-search
  // preset without storing provider config. Inactive observability remains ineligible.
  return (presetNames, pruning = {}) =>
    pruneDisabledMessagingPolicyPresets(presetNames, options.disabledChannels).filter(
      (name) =>
        (pruning.preserveExplicitWebSearch ||
          !isStaleBuiltinWebSearchPolicyPreset(name, options)) &&
        !isInactiveObservabilityPolicyPreset(name, options),
    );
}
