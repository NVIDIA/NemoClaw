// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type WebSearchConfig, webSearchProviderForConfig } from "../inference/web-search";
import * as policies from "../policy";
import * as tiers from "../policy/tiers";
import {
  PERSONAL_OPEN_INTERNET_PRESET_NAME,
  PERSONAL_POLICY_TIER_NAME,
  type TierDefinition,
} from "../policy/tiers";
import {
  filterSetupPolicyPresetNamesForAgent,
  filterSetupPolicyPresetsForAgent,
  setupPolicyPresetAppliesToAgent,
} from "./agent-policy-presets";
import {
  allHermesToolGatewayPolicyPresets,
  HERMES_TOOL_GATEWAY_PRESET_NAMES,
} from "./hermes-managed-tools";
import {
  allMessagingChannelPolicyPresets,
  mergePolicyMessagingChannels,
  pruneInactiveMessagingPolicyPresets,
} from "./messaging-policy-presets";
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
import { syncPresetSelection } from "./policy-preset-sync";
import { getSuggestedPolicyPresets } from "./policy-presets";
import {
  type PreparedPolicyResumeSelection,
  preparePolicyPresetResumeSelection,
} from "./policy-resume-selection";
import {
  createPolicySelectionPromptHelpers,
  type PolicySelectionPromptDeps,
} from "./policy-selection-prompts";
import * as policyTierEnv from "./policy-tier-env";
import {
  agentRequiredPresetAdditions,
  emitSuppressedAgentRequiredPresetsNote,
  ensureRequiredTierPolicyPresets,
  filterSuppressedAgentRequiredPresets,
  RESTRICTED_TIER_NAME,
} from "./policy-tier-suppression";
import { withPolicyApplicationTrace } from "./tracing";

export { suppressedAgentRequiredPresets } from "./policy-tier-suppression";

export type OnboardPolicyApplicationDeps = Omit<
  PolicySelectionPromptDeps,
  "tiers" | "policyTierEnv"
> & {
  step: (number: number, total: number, title: string) => void;
  localInferenceProviders: readonly string[];
  withSandboxMutationLock: typeof import("../state/mcp-lifecycle-lock").withSandboxMutationLock;
  waitForSandboxReady(sandboxName: string): boolean;
  waitForSandboxControlPlaneReady(sandboxName: string): boolean;
  parsePolicyPresetEnv(raw: string): string[];
  env: NodeJS.ProcessEnv;
};

type Preset = { name: string; access?: string };
type SupportOptions = { webSearchSupported?: boolean | null; agent?: string | null };
type PoliciesApi = {
  setupPolicyPresetSupported(name: string, options?: SupportOptions): boolean;
  listSetupPolicyPresets(sandboxName: string, options?: SupportOptions): Preset[];
  listCustomPresets(sandboxName: string): Preset[];
  getAppliedPresets(sandboxName: string): string[];
  customPresetOwnsNetworkPolicyKey?(sandboxName: string, policyKey: string): boolean;
  clampSetupPolicyPresetNames(
    names: string[],
    selectablePresets: Preset[],
    options?: SupportOptions,
    customPresetNames?: Set<string>,
  ): string[];
};
type TiersApi = {
  resolveTierPresets(tierName: string): Preset[];
  getTier(tierName: string): TierDefinition | null;
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
  /** Process-local exclusions imposed by a narrower runtime route authority. */
  excludedPresets?: readonly string[];
  revalidateSandboxIdentity?: (operation: string) => void;
};

export type SetupPolicySelectionDeps = {
  policies: PoliciesApi;
  tiers: TiersApi;
  localInferenceProviders: readonly string[];
  step: (number: number, total: number, title: string) => void;
  note: (message: string) => void;
  isNonInteractive: () => boolean;
  waitForSandboxReady: (sandboxName: string) => boolean;
  waitForSandboxControlPlaneReady: (sandboxName: string) => boolean;
  syncPresetSelection: (
    sandboxName: string,
    currentAppliedPresets: string[],
    selectedPresets: string[],
    accessByName?: Record<string, string>,
  ) => void;
  selectPolicyTier: () => Promise<string>;
  selectTierPresetsAndAccess: (
    tierName: string,
    presets: Preset[],
    initialSelected: string[],
  ) => Promise<Array<Preset & { access: string }>>;
  parsePolicyPresetEnv: (raw: string) => string[];
  env?: NodeJS.ProcessEnv;
};

export function createOnboardPolicyApplication(deps: OnboardPolicyApplicationDeps) {
  const promptHelpers = () =>
    createPolicySelectionPromptHelpers({
      ...deps,
      tiers,
      policyTierEnv,
    });
  const selectPolicyTier = () => promptHelpers().selectPolicyTier();
  const selectTierPresetsAndAccess = (
    tierName: string,
    allPresets: Array<{ name: string; description?: string }>,
    initialSelected?: string[],
  ) => promptHelpers().selectTierPresetsAndAccess(tierName, allPresets, initialSelected);
  const presetsCheckboxSelector = (
    allPresets: Array<{ name: string; description: string }>,
    initialSelected: string[],
  ) => promptHelpers().presetsCheckboxSelector(allPresets, initialSelected);
  const setupDeps: SetupPolicySelectionDeps = {
    policies,
    tiers,
    localInferenceProviders: deps.localInferenceProviders,
    step: deps.step,
    note: deps.note,
    isNonInteractive: deps.isNonInteractive,
    waitForSandboxReady: deps.waitForSandboxReady,
    waitForSandboxControlPlaneReady: deps.waitForSandboxControlPlaneReady,
    syncPresetSelection,
    selectPolicyTier,
    selectTierPresetsAndAccess,
    parsePolicyPresetEnv: deps.parsePolicyPresetEnv,
    env: deps.env,
  };

  return {
    arePolicyPresetsApplied(sandboxName: string, selectedPresets: string[] = []): boolean {
      if (!Array.isArray(selectedPresets) || selectedPresets.length === 0) return false;
      const applied = new Set(policies.getAppliedPresets(sandboxName));
      return selectedPresets.every((preset) => applied.has(preset));
    },
    computeSetupPresetSuggestions(
      tierName: string,
      options: SetupPresetSuggestionOptions = {},
    ): string[] {
      return computeSetupPresetSuggestions(
        {
          policies,
          tiers,
          localInferenceProviders: deps.localInferenceProviders,
        },
        tierName,
        options,
      );
    },
    filterSetupPolicyPresets: policies.filterSetupPolicyPresets,
    getSuggestedPolicyPresets,
    mergePolicyMessagingChannels,
    preparePolicyPresetResumeSelection(
      sandboxName: string,
      options: Parameters<typeof preparePolicyPresetResumeSelection>[2],
    ): PreparedPolicyResumeSelection {
      return preparePolicyPresetResumeSelection({ policies }, sandboxName, options);
    },
    presetsCheckboxSelector,
    resolveSandboxBaselinePolicy: policies.resolveSandboxBaselinePolicy,
    selectPolicyTier,
    selectTierPresetsAndAccess,
    setupPoliciesWithSelection(
      sandboxName: string,
      options: SetupPolicySelectionOptions = {},
    ): Promise<string[]> {
      return deps.withSandboxMutationLock(sandboxName, () =>
        setupPoliciesWithSelection(setupDeps, sandboxName, options),
      );
    },
    validatePolicyTierEnvEarly: policyTierEnv.validatePolicyTierEnvEarly,
  };
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
    observabilityEnabled = false,
    env = process.env,
  } = options;
  const known = Array.isArray(options.knownPresetNames) ? new Set(options.knownPresetNames) : null;
  const supportOptions = { webSearchSupported: options.webSearchSupported };
  const suggestions = pruneInactiveMessagingPolicyPresets(
    deps.tiers
      .resolveTierPresets(tierName)
      .map((preset) => preset.name)
      .filter((name) => setupPolicyPresetAppliesToAgent(name, agent))
      .filter(
        (name) =>
          !isStaleBuiltinWebSearchPolicyPreset(name, {
            webSearchConfig,
            customPresetNames: options.customPresetNames,
            tierName,
            agentName: agent,
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
      .filter((name) => !known || known.has(name)),
    enabledChannels,
    options.customPresetNames,
  );
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
        tierName,
        agentName: agent,
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
  return filterSuppressedAgentRequiredPresets(suggestions, tierName, agent);
}

export { type PreparedPolicyResumeSelection, preparePolicyPresetResumeSelection };

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

function requireSandboxReady(
  deps: SetupPolicySelectionDeps,
  sandboxName: string,
  stage: "before" | "after",
): void {
  if (!deps.waitForSandboxReady(sandboxName)) {
    console.error(`  Sandbox '${sandboxName}' was not ready ${stage} policy application.`);
    process.exit(1);
  }
  if (stage === "after" && !deps.waitForSandboxControlPlaneReady(sandboxName)) {
    console.error(
      `  Sandbox '${sandboxName}' did not re-register with OpenShell after policy application.`,
    );
    process.exit(1);
  }
}

function refuseInPlacePersonalRemoval(
  personalAlreadyActive: boolean,
  target: readonly string[],
): void {
  if (personalAlreadyActive && !target.includes(PERSONAL_OPEN_INTERNET_PRESET_NAME)) {
    console.error(
      "  Personal open internet cannot be removed in place because it replaces overlapping web routes. Create a new sandbox with another policy tier instead.",
    );
    process.exit(1);
  }
}

async function setupPoliciesWithSelectionInner(
  deps: SetupPolicySelectionDeps,
  sandboxName: string,
  options: SetupPolicySelectionOptions = {},
): Promise<string[]> {
  const excludedPresets = new Set(options.excludedPresets ?? []);
  const excludePresets = (names: readonly string[]) =>
    names.filter((name) => !excludedPresets.has(name));
  const selectedPresets = Array.isArray(options.selectedPresets)
    ? excludePresets(options.selectedPresets)
    : null;
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
  ).filter((preset) => !excludedPresets.has(preset.name));
  const knownPresets = new Set(allPresets.map((preset) => preset.name));
  const customPresetNames = new Set(
    deps.policies.listCustomPresets(sandboxName).map((preset) => preset.name),
  );
  const customOwnsObservability =
    deps.policies.customPresetOwnsNetworkPolicyKey?.(
      sandboxName,
      OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
    ) === true;
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
    ...filterSetupPolicyPresetNamesForAgent(excludePresets(currentAppliedPresets), agent).map(
      (name) => ({
        name,
      }),
    ),
  ];
  const applied = deps.policies.clampSetupPolicyPresetNames(
    excludePresets(currentAppliedPresets),
    selectablePresets,
    supportOptions,
    customPresetNames,
  );
  const pruneUnavailablePresets = createUnavailablePolicyPresetPruner({
    disabledChannels,
    enabledChannels,
    agent,
    observabilityEnabled,
    webSearchConfig,
    customPresetNames,
    customOwnsObservability,
  });
  const filterSupportedPresetNames = (presetNames: string[]) =>
    filterSetupPolicyPresetNamesForAgent(excludePresets(presetNames), agent).filter(
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
  const requestedTierName = options.tierName ?? null;
  const personalAlreadyActive =
    currentAppliedPresets.includes(PERSONAL_OPEN_INTERNET_PRESET_NAME) ||
    (selectedPresets !== null && options.tierName === PERSONAL_POLICY_TIER_NAME);
  if (chosen !== null) {
    const knownSelectablePresets = new Set(selectablePresets.map((preset) => preset.name));
    chosen = mergeRequiredSetupPolicyPresets(chosen, {
      enabledChannels,
      hermesToolGateways,
      agent,
      observabilityEnabled,
      knownPresetNames: knownSelectablePresets,
      env: deps.env,
      tierName: requestedTierName,
      webSearchConfig,
      customPresetNames,
      customOwnsObservability,
    });
    // Pass the requested tier so the pruner exempts that tier's egress defaults
    // (e.g. `brave` on Balanced) via provenance — a reconcile-triggered reuse
    // reapply must not narrow an applied tier default. (#6844)
    chosen = excludePresets(pruneUnavailablePresets(chosen, { tierName: requestedTierName }));
    chosen = ensureRequiredTierPolicyPresets(requestedTierName, chosen);
  }

  if (selectedPresets !== null) {
    const resumeSelection = chosen || [];
    refuseInPlacePersonalRemoval(personalAlreadyActive, resumeSelection);
    requireSandboxReady(deps, sandboxName, "before");
    deps.note(`  [resume] Reapplying policy presets: ${resumeSelection.join(", ")}`);
    options.revalidateSandboxIdentity?.(
      `reapply selected policy presets to sandbox '${sandboxName}'`,
    );
    deps.syncPresetSelection(sandboxName, currentAppliedPresets, resumeSelection);
    requireSandboxReady(deps, sandboxName, "after");
    if (onSelection) onSelection(resumeSelection);
    return resumeSelection;
  }

  const tierName = requestedTierName ?? (await deps.selectPolicyTier());
  if (personalAlreadyActive && tierName !== PERSONAL_POLICY_TIER_NAME) {
    refuseInPlacePersonalRemoval(personalAlreadyActive, []);
  }
  const personalTier = tierName === PERSONAL_POLICY_TIER_NAME;
  // The carry-forward set decides which *already applied* presets survive, so it
  // needs the applied tier for the same provenance exemption the resume reapply
  // above uses: `brave` on Balanced/Open is that tier's egress default, not a
  // stale web-search leftover, so declining the web-search tool on re-onboard
  // must not narrow it. Resolved after `tierName` so a freshly prompted tier
  // counts too; Restricted lists no such default and still prunes. (#6844, #10404)
  const appliedForPreservation = pruneUnavailablePresets(applied, { tierName });
  const suggestions = excludePresets(
    pruneUnavailablePresets(
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
      { preserveExplicitWebSearch: personalTier },
    ),
  );
  const suppressedNames = emitSuppressedAgentRequiredPresetsNote(tierName, agent, deps.note);

  if (deps.isNonInteractive()) {
    const policyMode = (deps.env?.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
    chosen = suggestions;
    let isAuthoritative = false;

    if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
      const retainedPresets = mergeRequiredSetupPolicyPresets(
        ensureRequiredTierPolicyPresets(
          tierName,
          filterSuppressedAgentRequiredPresets(
            excludePresets(pruneUnavailablePresets(currentAppliedPresets, { tierName })),
            tierName,
            agent,
          ),
        ),
        {
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
        },
      );
      const selectionChanged =
        retainedPresets.length !== currentAppliedPresets.length ||
        retainedPresets.some((name, index) => name !== currentAppliedPresets[index]);
      if (selectionChanged) {
        refuseInPlacePersonalRemoval(personalAlreadyActive, retainedPresets);
        requireSandboxReady(deps, sandboxName, "before");
        deps.note(
          personalTier
            ? "  [non-interactive] Applying the Personal tier requirement while skipping optional policy presets."
            : "  [non-interactive] Removing excluded or unavailable policy presets.",
        );
        options.revalidateSandboxIdentity?.(
          `apply retained policy presets to sandbox '${sandboxName}'`,
        );
        deps.syncPresetSelection(sandboxName, currentAppliedPresets, retainedPresets);
        requireSandboxReady(deps, sandboxName, "after");
        if (onSelection) onSelection(retainedPresets);
        return retainedPresets;
      }
      deps.note("  [non-interactive] Skipping optional policy presets.");
      return personalTier ? retainedPresets : [];
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
    chosen = excludePresets(
      pruneUnavailablePresets(chosen, {
        preserveExplicitWebSearch: isAuthoritative || personalTier,
        tierName,
      }),
    );
    chosen = ensureRequiredTierPolicyPresets(tierName, chosen);

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

    refuseInPlacePersonalRemoval(personalAlreadyActive, chosen);
    requireSandboxReady(deps, sandboxName, "before");
    deps.note(`  [non-interactive] Applying policy presets: ${chosen.join(", ")}`);
    options.revalidateSandboxIdentity?.(
      `apply non-interactive policy presets to sandbox '${sandboxName}'`,
    );
    deps.syncPresetSelection(sandboxName, currentAppliedPresets, chosen);
    requireSandboxReady(deps, sandboxName, "after");
    if (onSelection) onSelection(chosen);
    return chosen;
  }

  const knownNames = new Set(allPresets.map((preset) => preset.name));
  const initialSelected = [
    ...appliedForPreservation.filter((name) => knownNames.has(name)),
    ...suggestions.filter((name) => knownNames.has(name) && !applied.includes(name)),
  ];
  const resolvedPresets = await deps.selectTierPresetsAndAccess(
    tierName,
    allPresets,
    initialSelected,
  );
  const interactiveChoice = ensureRequiredTierPolicyPresets(
    tierName,
    excludePresets(
      pruneUnavailablePresets(
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
      ),
    ),
  );

  refuseInPlacePersonalRemoval(personalAlreadyActive, interactiveChoice);
  requireSandboxReady(deps, sandboxName, "before");

  const accessByName: Record<string, string> = {};
  const interactiveChoiceNames = new Set(interactiveChoice);
  for (const preset of resolvedPresets) {
    if (interactiveChoiceNames.has(preset.name)) accessByName[preset.name] = preset.access;
  }
  options.revalidateSandboxIdentity?.(`apply policy presets to sandbox '${sandboxName}'`);
  deps.syncPresetSelection(sandboxName, currentAppliedPresets, interactiveChoice, accessByName);
  requireSandboxReady(deps, sandboxName, "after");
  if (onSelection) onSelection(interactiveChoice);
  return interactiveChoice;
}
