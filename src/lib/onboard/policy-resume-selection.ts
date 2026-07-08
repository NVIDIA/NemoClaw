// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type WebSearchConfig, webSearchProviderForConfig } from "../inference/web-search";
import {
  filterSetupPolicyPresetNamesForAgent,
  filterSetupPolicyPresetsForAgent,
} from "./agent-policy-presets";
import {
  hasDisabledMessagingPolicyPreset,
  mergeAppliedPolicyPresetsForDisabledMessagingCleanup,
  pruneDisabledMessagingPolicyPresets,
} from "./messaging-policy-presets";
import {
  isInactiveObservabilityPolicyPreset,
  OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
} from "./observability-policy-presets";
import {
  isStaleBuiltinWebSearchPolicyPreset,
  mergeRequiredSetupPolicyPresets,
  type PreparedPolicyResumeSelection,
} from "./policy-selection";
import { suppressedAgentRequiredPresets } from "./policy-tier-suppression";

type Preset = { name: string; access?: string };

type PoliciesApi = {
  setupPolicyPresetSupported(
    name: string,
    options?: { webSearchSupported?: boolean | null; agent?: string | null },
  ): boolean;
  listSetupPolicyPresets(
    sandboxName: string,
    options?: { webSearchSupported?: boolean | null; agent?: string | null },
  ): Preset[];
  listCustomPresets(sandboxName: string): Preset[];
  getAppliedPresets(sandboxName: string): string[];
  customPresetOwnsNetworkPolicyKey?(sandboxName: string, policyKey: string): boolean;
  removeBuiltinPresetAttribution?(sandboxName: string, presetName: string): void;
  clampSetupPolicyPresetNames(
    names: string[],
    selectablePresets: Preset[],
    options?: { webSearchSupported?: boolean | null },
    customPresetNames?: Set<string>,
  ): string[];
};

export function preparePolicyPresetResumeSelection(
  deps: { policies: PoliciesApi },
  sandboxName: string,
  options: {
    recordedPolicyPresets: string[] | null;
    disabledChannels?: string[] | null;
    enabledChannels?: string[] | null;
    hermesToolGateways?: string[] | null;
    agent?: string | null;
    observabilityEnabled?: boolean | null;
    webSearchConfig?: WebSearchConfig | null;
    webSearchConfigChanged?: boolean;
    webSearchSupported?: boolean | null;
    env?: NodeJS.ProcessEnv;
    tierName?: string | null;
  },
): PreparedPolicyResumeSelection {
  const supportOptions = { webSearchSupported: options.webSearchSupported, agent: options.agent };
  const customPolicyPresetNames = new Set(
    deps.policies.listCustomPresets(sandboxName).map((preset) => preset.name),
  );
  const customOwnsObservability =
    deps.policies.customPresetOwnsNetworkPolicyKey?.(
      sandboxName,
      OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
    ) === true;
  if (customOwnsObservability) {
    deps.policies.removeBuiltinPresetAttribution?.(
      sandboxName,
      OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
    );
  }
  const rawAppliedPolicyPresets = deps.policies.getAppliedPresets(sandboxName);
  const appliedPolicyPresets = customOwnsObservability
    ? [...new Set(rawAppliedPolicyPresets)].filter(
        (name) =>
          name !== OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET ||
          customPolicyPresetNames.has(OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET),
      )
    : rawAppliedPolicyPresets;
  const selectablePolicyPresets = [
    ...filterSetupPolicyPresetsForAgent(
      deps.policies.listSetupPolicyPresets(sandboxName, supportOptions),
      options.agent,
    ),
    ...filterSetupPolicyPresetNamesForAgent(appliedPolicyPresets, options.agent).map((name) => ({
      name,
    })),
  ];
  const clampedRecordedPolicyPresets = deps.policies.clampSetupPolicyPresetNames(
    options.recordedPolicyPresets || [],
    selectablePolicyPresets,
    supportOptions,
    customPolicyPresetNames,
  );
  const isStaleBuiltinWebSearch = (name: string) =>
    isStaleBuiltinWebSearchPolicyPreset(name, {
      webSearchConfig: options.webSearchConfig,
      customPresetNames: customPolicyPresetNames,
    });
  const isInactiveObservability = (name: string) =>
    isInactiveObservabilityPolicyPreset(name, {
      agent: options.agent,
      observabilityEnabled: options.observabilityEnabled,
      customPresetNames: customPolicyPresetNames,
      customOwnsObservability,
    });
  const recordedBuiltinWebSearchProviderChanged = clampedRecordedPolicyPresets.some(
    (name) => (name === "brave" || name === "tavily") && isStaleBuiltinWebSearch(name),
  );
  let policyPresets = pruneDisabledMessagingPolicyPresets(
    clampedRecordedPolicyPresets.filter(
      (name) => !isStaleBuiltinWebSearch(name) && !isInactiveObservability(name),
    ),
    options.disabledChannels,
  );
  const appliedPolicyPresetsForSupport = deps.policies
    .clampSetupPolicyPresetNames(
      appliedPolicyPresets,
      selectablePolicyPresets,
      supportOptions,
      customPolicyPresetNames,
    )
    .filter((name) => !isStaleBuiltinWebSearch(name) && !isInactiveObservability(name));
  const disabledMessagingPolicyPresetApplied = hasDisabledMessagingPolicyPreset(
    appliedPolicyPresetsForSupport,
    options.disabledChannels,
  );
  policyPresets = mergeAppliedPolicyPresetsForDisabledMessagingCleanup(
    policyPresets,
    appliedPolicyPresetsForSupport,
    options.disabledChannels,
  );
  if (Array.isArray(options.recordedPolicyPresets)) {
    policyPresets = mergeRequiredSetupPolicyPresets(policyPresets, {
      enabledChannels: options.enabledChannels,
      hermesToolGateways: options.hermesToolGateways,
      agent: options.agent,
      observabilityEnabled: options.observabilityEnabled,
      knownPresetNames: selectablePolicyPresets.map((preset) => preset.name),
      env: options.env,
      tierName: options.tierName,
      webSearchConfig: options.webSearchConfig,
      customPresetNames: customPolicyPresetNames,
      customOwnsObservability,
    });

    // Provider switches are build-time changes, but their matching egress
    // preset is runtime state. Resume must add the newly active provider after
    // pruning the stale one or the replacement sandbox cannot reach search.
    const activeWebSearchPreset = options.webSearchConfig
      ? webSearchProviderForConfig(options.webSearchConfig)
      : null;
    const selectablePolicyPresetNames = new Set(
      selectablePolicyPresets.map((preset) => preset.name),
    );
    if (
      activeWebSearchPreset &&
      options.webSearchSupported !== false &&
      (options.webSearchConfigChanged === true || recordedBuiltinWebSearchProviderChanged) &&
      selectablePolicyPresetNames.has(activeWebSearchPreset) &&
      !policyPresets.includes(activeWebSearchPreset)
    ) {
      policyPresets.push(activeWebSearchPreset);
    }
  }
  const recordedPolicyPresetsNeedReconcile =
    Array.isArray(options.recordedPolicyPresets) &&
    (policyPresets.length !== options.recordedPolicyPresets.length ||
      policyPresets.some((name) => !options.recordedPolicyPresets?.includes(name)) ||
      options.recordedPolicyPresets.some((name) => !policyPresets.includes(name)));
  const suppressedForTier = options.tierName
    ? new Set(suppressedAgentRequiredPresets(options.tierName, options.agent))
    : null;
  const suppressedAgentRequiredPresetsLive =
    suppressedForTier !== null &&
    suppressedForTier.size > 0 &&
    appliedPolicyPresets.some((name) => suppressedForTier.has(name));

  return {
    policyPresets,
    recordedPolicyPresetsNeedReconcile,
    disabledMessagingPolicyPresetApplied,
    suppressedAgentRequiredPresetsLive,
  };
}
