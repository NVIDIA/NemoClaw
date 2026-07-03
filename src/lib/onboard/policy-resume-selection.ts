// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
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
  isStaleBuiltinBravePolicyPreset,
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
    webSearchConfig?: WebSearchConfig | null;
    webSearchSupported?: boolean | null;
    env?: NodeJS.ProcessEnv;
    tierName?: string | null;
  },
): PreparedPolicyResumeSelection {
  const supportOptions = { webSearchSupported: options.webSearchSupported, agent: options.agent };
  const appliedPolicyPresets = deps.policies.getAppliedPresets(sandboxName);
  const selectablePolicyPresets = [
    ...filterSetupPolicyPresetsForAgent(
      deps.policies.listSetupPolicyPresets(sandboxName, supportOptions),
      options.agent,
    ),
    ...filterSetupPolicyPresetNamesForAgent(appliedPolicyPresets, options.agent).map((name) => ({
      name,
    })),
  ];
  const customPolicyPresetNames = new Set(
    deps.policies.listCustomPresets(sandboxName).map((preset) => preset.name),
  );
  const clampedRecordedPolicyPresets = deps.policies.clampSetupPolicyPresetNames(
    options.recordedPolicyPresets || [],
    selectablePolicyPresets,
    supportOptions,
    customPolicyPresetNames,
  );
  const isStaleBuiltinBrave = (name: string) =>
    isStaleBuiltinBravePolicyPreset(name, {
      webSearchConfig: options.webSearchConfig,
      customPresetNames: customPolicyPresetNames,
    });
  let policyPresets = pruneDisabledMessagingPolicyPresets(
    clampedRecordedPolicyPresets.filter((name) => !isStaleBuiltinBrave(name)),
    options.disabledChannels,
  );
  const recordedPolicyPresetsNeedReconcile =
    Array.isArray(options.recordedPolicyPresets) &&
    policyPresets.length !== options.recordedPolicyPresets.length;
  const appliedPolicyPresetsForSupport = deps.policies
    .clampSetupPolicyPresetNames(
      appliedPolicyPresets,
      selectablePolicyPresets,
      supportOptions,
      customPolicyPresetNames,
    )
    .filter((name) => !isStaleBuiltinBrave(name));
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
      knownPresetNames: selectablePolicyPresets.map((preset) => preset.name),
      env: options.env,
      tierName: options.tierName,
    });
  }
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
