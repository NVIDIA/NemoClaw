// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import {
  filterSetupPolicyPresetNamesForAgent,
  filterSetupPolicyPresetsForAgent,
  setupPolicyPresetAppliesToAgent,
} from "./agent-policy-presets";
import {
  allHermesToolGatewayPolicyPresets,
  HERMES_TOOL_GATEWAY_PRESET_NAMES,
  mergeRequiredHermesToolGatewayPolicyPresets,
} from "./hermes-managed-tools";
import {
  hasDisabledMessagingPolicyPreset,
  mergeAppliedPolicyPresetsForDisabledMessagingCleanup,
  mergeRequiredMessagingChannelPolicyPresets,
  pruneDisabledMessagingPolicyPresets,
  requiredMessagingChannelPolicyPresets,
} from "./messaging-policy-presets";
import {
  isOpenclawAgent,
  mergeRequiredOpenclawOtelPolicyPresets,
  requiredOpenclawOtelPolicyPresets,
} from "./openclaw-otel-policy-presets";
import { withPolicyApplicationTrace } from "./tracing";

type Preset = { name: string; access?: string };
type SupportOptions = { webSearchSupported?: boolean | null };
type PoliciesApi = {
  setupPolicyPresetSupported(name: string, options?: SupportOptions): boolean;
  listSetupPolicyPresets(sandboxName: string, options?: SupportOptions): Preset[];
  listCustomPresets(sandboxName: string): Preset[];
  getAppliedPresets(sandboxName: string): string[];
  clampSetupPolicyPresetNames(
    names: string[],
    selectablePresets: Preset[],
    options?: SupportOptions,
    customPresetNames?: Set<string>,
  ): string[];
};
type TiersApi = {
  resolveTierPresets(tierName: string): Preset[];
  getTier(tierName: string): unknown;
};

export type SetupPresetSuggestionOptions = {
  enabledChannels?: string[] | null;
  webSearchConfig?: WebSearchConfig | null;
  provider?: string | null;
  agent?: string | null;
  knownPresetNames?: string[] | null;
  webSearchSupported?: boolean | null;
  hermesToolGateways?: string[] | null;
  env?: NodeJS.ProcessEnv;
};

export type SetupPolicySelectionOptions = {
  selectedPresets?: string[] | null;
  onSelection?: ((policyPresets: string[]) => void) | null;
  webSearchConfig?: WebSearchConfig | null;
  enabledChannels?: string[] | null;
  provider?: string | null;
  agent?: string | null;
  knownPresetNames?: string[];
  webSearchSupported?: boolean | null;
  hermesToolGateways?: string[] | null;
  disabledChannels?: string[] | null;
};

export type SetupPolicySelectionDeps = {
  policies: PoliciesApi;
  tiers: TiersApi;
  localInferenceProviders: readonly string[];
  step: (number: number, total: number, title: string) => void;
  note: (message: string) => void;
  isNonInteractive: () => boolean;
  waitForSandboxReady: (sandboxName: string) => boolean;
  syncPresetSelection: (
    sandboxName: string,
    currentAppliedPresets: string[],
    selectedPresets: string[],
    accessByName?: Record<string, string>,
  ) => void;
  selectPolicyTier: () => Promise<string>;
  setPolicyTier?: (sandboxName: string, tierName: string) => void;
  selectTierPresetsAndAccess: (
    tierName: string,
    presets: Preset[],
    extraSelected: string[],
  ) => Promise<Array<Preset & { access: string }>>;
  parsePolicyPresetEnv: (raw: string) => string[];
  env?: NodeJS.ProcessEnv;
};

export type PreparedPolicyResumeSelection = {
  policyPresets: string[];
  recordedPolicyPresetsNeedReconcile: boolean;
  disabledMessagingPolicyPresetApplied: boolean;
};

export function mergeRequiredSetupPolicyPresets(
  policyPresets: string[],
  options: {
    enabledChannels?: string[] | null;
    hermesToolGateways?: string[] | null;
    agent?: string | null;
    knownPresetNames?: string[] | Set<string> | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): string[] {
  const agentFilteredPresets = filterSetupPolicyPresetNamesForAgent(
    policyPresets,
    options.agent,
  );
  const mergedPresets = mergeRequiredOpenclawOtelPolicyPresets(
    mergeRequiredMessagingChannelPolicyPresets(
      mergeRequiredHermesToolGatewayPolicyPresets(
        agentFilteredPresets,
        options.hermesToolGateways,
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
  );
  return filterSetupPolicyPresetNamesForAgent(mergedPresets, options.agent);
}

export function isStaleBuiltinBravePolicyPreset(
  name: string,
  options: {
    webSearchConfig?: WebSearchConfig | null;
    customPresetNames?: ReadonlySet<string> | null;
  } = {},
): boolean {
  return (
    name === "brave" &&
    !options.webSearchConfig &&
    !options.customPresetNames?.has(name)
  );
}

export function computeSetupPresetSuggestions(
  deps: {
    policies: PoliciesApi;
    tiers: TiersApi;
    localInferenceProviders: readonly string[];
    env?: NodeJS.ProcessEnv;
  },
  tierName: string,
  options: SetupPresetSuggestionOptions = {},
): string[] {
  const {
    enabledChannels = null,
    webSearchConfig = null,
    provider = null,
    agent = null,
    env = process.env,
  } = options;
  const known = Array.isArray(options.knownPresetNames) ? new Set(options.knownPresetNames) : null;
  const supportOptions = { webSearchSupported: options.webSearchSupported };
  const suggestions = deps.tiers
    .resolveTierPresets(tierName)
    .map((preset) => preset.name)
    .filter((name) => setupPolicyPresetAppliesToAgent(name, agent))
    .filter((name) => !isStaleBuiltinBravePolicyPreset(name, { webSearchConfig }))
    .filter((name) => deps.policies.setupPolicyPresetSupported(name, supportOptions))
    .filter((name) => !known || known.has(name));
  const add = (name: string) => {
    if (!setupPolicyPresetAppliesToAgent(name, agent)) return;
    if (!deps.policies.setupPolicyPresetSupported(name, supportOptions)) return;
    if (suggestions.includes(name)) return;
    if (known && !known.has(name)) return;
    suggestions.push(name);
  };
  if (webSearchConfig) add("brave");
  if (provider && deps.localInferenceProviders.includes(provider)) add("local-inference");
  if (isOpenclawAgent(agent)) {
    add("openclaw-pricing");
    for (const preset of requiredOpenclawOtelPolicyPresets(agent, env)) add(preset);
  }
  if (tierName === "open" && typeof agent === "string" && agent.trim().toLowerCase() === "hermes") {
    for (const preset of allHermesToolGatewayPolicyPresets()) add(preset);
  }
  if (Array.isArray(enabledChannels)) {
    for (const channel of enabledChannels) add(channel);
    for (const preset of requiredMessagingChannelPolicyPresets(enabledChannels)) add(preset);
  }
  if (Array.isArray(options.hermesToolGateways)) {
    for (const preset of options.hermesToolGateways) {
      if (HERMES_TOOL_GATEWAY_PRESET_NAMES.has(preset)) add(preset);
    }
  }
  return suggestions;
}

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
  },
): PreparedPolicyResumeSelection {
  const supportOptions = { webSearchSupported: options.webSearchSupported };
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
    });
  }

  return {
    policyPresets,
    recordedPolicyPresetsNeedReconcile,
    disabledMessagingPolicyPresetApplied,
  };
}

export async function setupPoliciesWithSelection(
  deps: SetupPolicySelectionDeps,
  sandboxName: string,
  options: SetupPolicySelectionOptions = {},
): Promise<string[]> {
  return withPolicyApplicationTrace(sandboxName, options, () =>
    setupPoliciesWithSelectionInner(deps, sandboxName, options),
  );
}

async function setupPoliciesWithSelectionInner(
  deps: SetupPolicySelectionDeps,
  sandboxName: string,
  options: SetupPolicySelectionOptions = {},
): Promise<string[]> {
  const selectedPresets = Array.isArray(options.selectedPresets) ? options.selectedPresets : null;
  const onSelection = typeof options.onSelection === "function" ? options.onSelection : null;
  const webSearchConfig = options.webSearchConfig || null;
  const enabledChannels = Array.isArray(options.enabledChannels) ? options.enabledChannels : null;
  const provider = options.provider || null;
  const agent = options.agent || null;
  const hermesToolGateways = Array.isArray(options.hermesToolGateways)
    ? options.hermesToolGateways
    : null;
  const disabledChannels = Array.isArray(options.disabledChannels)
    ? options.disabledChannels
    : null;

  deps.step(8, 8, "Policy presets");

  const supportOptions = { webSearchSupported: options.webSearchSupported };
  const allPresets = filterSetupPolicyPresetsForAgent(
    deps.policies.listSetupPolicyPresets(sandboxName, supportOptions),
    agent,
  );
  const knownPresets = new Set(allPresets.map((preset) => preset.name));
  const customPresetNames = new Set(
    deps.policies.listCustomPresets(sandboxName).map((preset) => preset.name),
  );
  const currentAppliedPresets = deps.policies.getAppliedPresets(sandboxName);
  const selectablePresets = [
    ...allPresets,
    ...filterSetupPolicyPresetNamesForAgent(currentAppliedPresets, agent).map((name) => ({
      name,
    })),
  ];
  const applied = deps.policies.clampSetupPolicyPresetNames(
    currentAppliedPresets,
    selectablePresets,
    supportOptions,
    customPresetNames,
  );
  const isStaleBuiltinBrave = (name: string) =>
    isStaleBuiltinBravePolicyPreset(name, { webSearchConfig, customPresetNames });
  const appliedForPreservation = pruneDisabledMessagingPolicyPresets(
    applied,
    disabledChannels,
  ).filter((name) => !isStaleBuiltinBrave(name));
  const pruneDisabledPresets = (presetNames: string[]) =>
    pruneDisabledMessagingPolicyPresets(presetNames, disabledChannels);
  const filterSupportedPresetNames = (presetNames: string[]) =>
    filterSetupPolicyPresetNamesForAgent(presetNames, agent).filter(
      (name) =>
        customPresetNames.has(name) ||
        deps.policies.setupPolicyPresetSupported(name, supportOptions),
    );
  let chosen =
    selectedPresets !== null
      ? deps.policies.clampSetupPolicyPresetNames(
          selectedPresets,
          selectablePresets,
          supportOptions,
          customPresetNames,
        )
      : null;
  if (chosen !== null) {
    const knownSelectablePresets = new Set(selectablePresets.map((preset) => preset.name));
    chosen = mergeRequiredSetupPolicyPresets(chosen, {
      enabledChannels,
      hermesToolGateways,
      agent,
      knownPresetNames: knownSelectablePresets,
      env: deps.env,
    });
    chosen = pruneDisabledPresets(chosen);
  }

  if (selectedPresets !== null) {
    const resumeSelection = chosen || [];
    if (onSelection) onSelection(resumeSelection);
    if (!deps.waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    deps.note(`  [resume] Reapplying policy presets: ${resumeSelection.join(", ")}`);
    deps.syncPresetSelection(sandboxName, currentAppliedPresets, resumeSelection);
    return resumeSelection;
  }

  const tierName = await deps.selectPolicyTier();
  deps.setPolicyTier?.(sandboxName, tierName);
  const suggestions = pruneDisabledPresets(
    computeSetupPresetSuggestions(deps, tierName, {
      enabledChannels,
      webSearchConfig,
      provider,
      agent,
      knownPresetNames: allPresets.map((preset) => preset.name),
      webSearchSupported: options.webSearchSupported,
      hermesToolGateways,
      env: deps.env,
    }),
  );

  if (deps.isNonInteractive()) {
    const policyMode = (deps.env?.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
    chosen = suggestions;
    let isAuthoritative = false;

    if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
      deps.note("  [non-interactive] Skipping policy presets.");
      return [];
    }

    if (policyMode === "custom" || policyMode === "list") {
      const envPresets = deps.parsePolicyPresetEnv(deps.env?.NEMOCLAW_POLICY_PRESETS || "");
      if (envPresets.length === 0) {
        console.error("  NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom.");
        process.exit(1);
      }
      chosen = filterSupportedPresetNames(envPresets);
      isAuthoritative = true;
    } else if (policyMode === "suggested" || policyMode === "default" || policyMode === "auto") {
      const envPresets = deps.parsePolicyPresetEnv(deps.env?.NEMOCLAW_POLICY_PRESETS || "");
      if (envPresets.length > 0) chosen = filterSupportedPresetNames(envPresets);
    } else {
      console.warn(`  Unsupported NEMOCLAW_POLICY_MODE: ${policyMode}`);
      console.warn(
        "  Valid values: suggested, custom, skip (aliases: default/auto, list, none/no).",
      );
      if (deps.tiers.getTier(policyMode)) {
        console.warn(
          `  '${policyMode}' is a policy tier — did you mean NEMOCLAW_POLICY_TIER=${policyMode}?`,
        );
      }
      console.warn(`  Falling back to suggested presets for tier '${tierName}'.`);
    }

    chosen = mergeRequiredSetupPolicyPresets(chosen, {
      enabledChannels,
      hermesToolGateways,
      agent,
      knownPresetNames: knownPresets,
      env: deps.env,
    });
    chosen = pruneDisabledPresets(chosen);

    const invalidPresets = chosen.filter((name) => !knownPresets.has(name));
    if (invalidPresets.length > 0) {
      console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
      process.exit(1);
    }

    if (!isAuthoritative) {
      const chosenSet = new Set(chosen);
      const preserved: string[] = [];
      for (const name of appliedForPreservation) {
        if (chosenSet.has(name)) continue;
        if (isStaleBuiltinBrave(name)) continue;
        chosen.push(name);
        chosenSet.add(name);
        preserved.push(name);
      }
      if (preserved.length > 0) {
        deps.note(`  [non-interactive] Preserving previously-applied presets: ${preserved.join(", ")}`);
      }
    }

    if (onSelection) onSelection(chosen);
    if (!deps.waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    deps.note(`  [non-interactive] Applying policy presets: ${chosen.join(", ")}`);
    deps.syncPresetSelection(sandboxName, currentAppliedPresets, chosen);
    return chosen;
  }

  const knownNames = new Set(allPresets.map((preset) => preset.name));
  const extraSelected = [
    ...appliedForPreservation.filter((name) => knownNames.has(name)),
    ...suggestions.filter((name) => knownNames.has(name) && !applied.includes(name)),
  ];
  const resolvedPresets = await deps.selectTierPresetsAndAccess(tierName, allPresets, extraSelected);
  const interactiveChoice = pruneDisabledPresets(
    mergeRequiredSetupPolicyPresets(
      resolvedPresets.map((preset) => preset.name),
      {
        enabledChannels,
        hermesToolGateways,
        agent,
        knownPresetNames: knownNames,
        env: deps.env,
      },
    ),
  );

  if (onSelection) onSelection(interactiveChoice);
  if (!deps.waitForSandboxReady(sandboxName)) {
    console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
    process.exit(1);
  }

  const accessByName: Record<string, string> = {};
  for (const preset of resolvedPresets) accessByName[preset.name] = preset.access;
  deps.syncPresetSelection(sandboxName, currentAppliedPresets, interactiveChoice, accessByName);
  return interactiveChoice;
}
