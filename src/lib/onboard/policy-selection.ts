// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type WebSearchConfig, webSearchProviderForConfig } from "../inference/web-search";
import {
  filterSetupPolicyPresetNamesForAgent,
  filterSetupPolicyPresetsForAgent,
  setupPolicyPresetAppliesToAgent,
} from "./agent-policy-presets";
import {
  allHermesToolGatewayPolicyPresets,
  HERMES_TOOL_GATEWAY_PRESET_NAMES,
} from "./hermes-managed-tools";
import { allMessagingChannelPolicyPresets } from "./messaging-policy-presets";
import {
  isInactiveObservabilityPolicyPreset,
  OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
  requiredObservabilityPolicyPresets,
} from "./observability-policy-presets";
import { seedInitialPolicyContext } from "./policy-context-seed";
import {
  createUnavailablePolicyPresetPruner,
  isStaleBuiltinWebSearchPolicyPreset,
  mergeRequiredSetupPolicyPresets,
} from "./policy-preset-reconciliation";
import {
  agentRequiredPresetAdditions,
  emitSuppressedAgentRequiredPresetsNote,
  RESTRICTED_TIER_NAME,
} from "./policy-tier-suppression";
import { withPolicyApplicationTrace } from "./tracing";

export {
  isStaleBuiltinBravePolicyPreset,
  isStaleBuiltinWebSearchPolicyPreset,
  mergeRequiredSetupPolicyPresets,
} from "./policy-preset-reconciliation";
export { suppressedAgentRequiredPresets } from "./policy-tier-suppression";

type Preset = { name: string; access?: string };
type SupportOptions = { webSearchSupported?: boolean | null; agent?: string | null };
type PoliciesApi = {
  setupPolicyPresetSupported(name: string, options?: SupportOptions): boolean;
  listSetupPolicyPresets(sandboxName: string, options?: SupportOptions): Preset[];
  listCustomPresets(sandboxName: string): Preset[];
  getAppliedPresets(sandboxName: string): string[];
  customPresetOwnsNetworkPolicyKey?(sandboxName: string, policyKey: string): boolean;
  removeBuiltinPresetAttribution?(sandboxName: string, presetName: string): void;
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
  observabilityEnabled?: boolean | null;
  knownPresetNames?: string[] | null;
  webSearchSupported?: boolean | null;
  hermesToolGateways?: string[] | null;
  customPresetNames?: ReadonlySet<string> | null;
  customOwnsObservability?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type SetupPolicySelectionOptions = {
  selectedPresets?: string[] | null;
  onSelection?: ((policyPresets: string[]) => void) | null;
  webSearchConfig?: WebSearchConfig | null;
  enabledChannels?: string[] | null;
  provider?: string | null;
  agent?: string | null;
  observabilityEnabled?: boolean | null;
  /** Authoritative tier for transactional resume before registry registration is complete. */
  tierName?: string | null;
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
  getRecordedPolicyTier?: (sandboxName: string) => string | null | undefined;
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
  suppressedAgentRequiredPresetsLive: boolean;
};

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
    observabilityEnabled = false,
    env = process.env,
  } = options;
  const known = Array.isArray(options.knownPresetNames) ? new Set(options.knownPresetNames) : null;
  const supportOptions = { webSearchSupported: options.webSearchSupported };
  const suggestions = deps.tiers
    .resolveTierPresets(tierName)
    .map((preset) => preset.name)
    .filter((name) => setupPolicyPresetAppliesToAgent(name, agent))
    .filter(
      (name) =>
        !isStaleBuiltinWebSearchPolicyPreset(name, {
          webSearchConfig,
          customPresetNames: options.customPresetNames,
        }),
    )
    .filter(
      (name) =>
        !isInactiveObservabilityPolicyPreset(name, {
          agent,
          observabilityEnabled,
          customPresetNames: options.customPresetNames,
          customOwnsObservability: options.customOwnsObservability,
        }),
    )
    .filter((name) => deps.policies.setupPolicyPresetSupported(name, supportOptions))
    .filter((name) => !known || known.has(name));
  const add = (name: string) => {
    if (!setupPolicyPresetAppliesToAgent(name, agent)) return;
    if (
      isInactiveObservabilityPolicyPreset(name, {
        agent,
        observabilityEnabled,
        customPresetNames: options.customPresetNames,
        customOwnsObservability: options.customOwnsObservability,
      })
    ) {
      return;
    }
    if (
      isStaleBuiltinWebSearchPolicyPreset(name, {
        webSearchConfig,
        customPresetNames: options.customPresetNames,
      })
    ) {
      return;
    }
    if (!deps.policies.setupPolicyPresetSupported(name, supportOptions)) return;
    if (suggestions.includes(name)) return;
    if (known && !known.has(name)) return;
    suggestions.push(name);
  };
  if (webSearchConfig) add(webSearchProviderForConfig(webSearchConfig));
  if (provider && deps.localInferenceProviders.includes(provider)) add("local-inference");
  if (tierName !== RESTRICTED_TIER_NAME) {
    for (const preset of agentRequiredPresetAdditions(agent, env)) add(preset);
    for (const preset of requiredObservabilityPolicyPresets(agent, observabilityEnabled)) {
      add(preset);
    }
  }
  if (tierName === "open" && typeof agent === "string" && agent.trim().toLowerCase() === "hermes") {
    for (const preset of allHermesToolGatewayPolicyPresets()) add(preset);
  }
  if (Array.isArray(enabledChannels)) {
    // Suggest every enabled channel's egress preset, matching the set
    // finalization merges via `mergeEnabledMessagingChannelPolicyPresets`.
    // Resolving through the channel→preset registry keeps the suggestion path
    // correct for any channel (and any future preset rename) without relying on
    // the channel name coinciding with its preset name or on `requiredAtCreate`
    // (#5967).
    for (const preset of allMessagingChannelPolicyPresets(enabledChannels)) add(preset);
  }
  if (Array.isArray(options.hermesToolGateways)) {
    for (const preset of options.hermesToolGateways) {
      if (HERMES_TOOL_GATEWAY_PRESET_NAMES.has(preset)) add(preset);
    }
  }
  return suggestions;
}

export { preparePolicyPresetResumeSelection } from "./policy-resume-selection";

export async function setupPoliciesWithSelection(
  deps: SetupPolicySelectionDeps,
  sandboxName: string,
  options: SetupPolicySelectionOptions = {},
): Promise<string[]> {
  const chosen = await withPolicyApplicationTrace(sandboxName, options, () =>
    setupPoliciesWithSelectionInner(deps, sandboxName, options),
  );
  seedInitialPolicyContext(sandboxName);
  return chosen;
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
  const observabilityEnabled = options.observabilityEnabled === true;
  const hermesToolGateways = Array.isArray(options.hermesToolGateways)
    ? options.hermesToolGateways
    : null;
  const disabledChannels = Array.isArray(options.disabledChannels)
    ? options.disabledChannels
    : null;

  deps.step(8, 8, "Policy presets");

  const supportOptions = { webSearchSupported: options.webSearchSupported, agent };
  const allPresets = filterSetupPolicyPresetsForAgent(
    deps.policies.listSetupPolicyPresets(sandboxName, supportOptions),
    agent,
  );
  const knownPresets = new Set(allPresets.map((preset) => preset.name));
  const customPresetNames = new Set(
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
  const rawCurrentAppliedPresets = deps.policies.getAppliedPresets(sandboxName);
  const currentAppliedPresets = customOwnsObservability
    ? [...new Set(rawCurrentAppliedPresets)].filter(
        (name) =>
          name !== OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET ||
          customPresetNames.has(OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET),
      )
    : rawCurrentAppliedPresets;
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
  const pruneUnavailablePresets = createUnavailablePolicyPresetPruner({
    disabledChannels,
    agent,
    observabilityEnabled,
    webSearchConfig,
    customPresetNames,
    customOwnsObservability,
  });
  const appliedForPreservation = pruneUnavailablePresets(applied);
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
  // Resume keeps the recorded tier so stale suppressed presets from that tier
  // still get filtered. An interrupted create can reach this fresh-selection
  // branch before presets are recorded, so its persisted tier must also win
  // over a new prompt or non-interactive default.
  const recordedTierName = options.tierName ?? deps.getRecordedPolicyTier?.(sandboxName) ?? null;
  if (chosen !== null) {
    const knownSelectablePresets = new Set(selectablePresets.map((preset) => preset.name));
    chosen = mergeRequiredSetupPolicyPresets(chosen, {
      enabledChannels,
      hermesToolGateways,
      agent,
      observabilityEnabled,
      knownPresetNames: knownSelectablePresets,
      env: deps.env,
      tierName: recordedTierName,
      webSearchConfig,
      customPresetNames,
      customOwnsObservability,
    });
    chosen = pruneUnavailablePresets(chosen);
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

  const tierName = recordedTierName ?? (await deps.selectPolicyTier());
  deps.setPolicyTier?.(sandboxName, tierName);
  const suggestions = pruneUnavailablePresets(
    computeSetupPresetSuggestions(deps, tierName, {
      enabledChannels,
      webSearchConfig,
      customPresetNames,
      customOwnsObservability,
      provider,
      agent,
      observabilityEnabled,
      knownPresetNames: allPresets.map((preset) => preset.name),
      webSearchSupported: options.webSearchSupported,
      hermesToolGateways,
      env: deps.env,
    }),
  );
  const suppressedNames = emitSuppressedAgentRequiredPresetsNote(tierName, agent, deps.note);

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
      if (envPresets.length > 0) {
        chosen = filterSupportedPresetNames(envPresets);
      }
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
      observabilityEnabled,
      knownPresetNames: knownPresets,
      env: deps.env,
      tierName,
      webSearchConfig,
      customPresetNames,
      customOwnsObservability,
    });
    chosen = pruneUnavailablePresets(chosen, {
      preserveExplicitWebSearch: isAuthoritative,
    });

    const invalidPresets = chosen.filter((name) => !knownPresets.has(name));
    if (invalidPresets.length > 0) {
      console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
      process.exit(1);
    }

    if (!isAuthoritative) {
      const chosenSet = new Set(chosen);
      // `kept` is the subset of `appliedForPreservation` that actually carries
      // forward — chosen-set duplicates, stale built-in brave, and
      // tier-suppressed agent-required presets (e.g. restricted's
      // openclaw-pricing / openclaw-diagnostics-otel-local) are intentionally
      // excluded so suppression survives the preservation pass.
      const kept: string[] = [];
      for (const name of appliedForPreservation) {
        if (chosenSet.has(name)) continue;
        if (suppressedNames.has(name)) continue;
        chosen.push(name);
        chosenSet.add(name);
        kept.push(name);
      }
      if (kept.length > 0) {
        deps.note(`  [non-interactive] Preserving previously-applied presets: ${kept.join(", ")}`);
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
  const resolvedPresets = await deps.selectTierPresetsAndAccess(
    tierName,
    allPresets,
    extraSelected,
  );
  const interactiveChoice = pruneUnavailablePresets(
    mergeRequiredSetupPolicyPresets(
      resolvedPresets.map((preset) => preset.name),
      {
        enabledChannels,
        hermesToolGateways,
        agent,
        observabilityEnabled,
        knownPresetNames: knownNames,
        env: deps.env,
        tierName,
        webSearchConfig,
        customPresetNames,
        customOwnsObservability,
      },
    ),
    { preserveExplicitWebSearch: true },
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
