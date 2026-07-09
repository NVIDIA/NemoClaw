// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type WebSearchConfig, webSearchProviderForConfig } from "../../inference/web-search";
import type { SandboxMessagingPlan } from "../../messaging";
import { mergeRebuildMessagingPolicyPresets } from "../../onboard/messaging-policy-presets";
import {
  isDcodeAgent,
  isInactiveObservabilityPolicyPreset,
  OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
  requiredObservabilityPolicyPresets,
} from "../../onboard/observability-policy-presets";
import { resolveRecreatePolicyPresets } from "../../onboard/policy-preset-persistence";
import { isStaleBuiltinWebSearchPolicyPreset } from "../../onboard/policy-selection";
import { filterSuppressedAgentRequiredPresets } from "../../onboard/policy-tier-suppression";
import { parsePresetPolicyKeys } from "../../policy";
import { hasCompleteOpenClawImagePluginProvenance } from "../../state/openclaw-plugin-restore";
import { hasAuthoritativeOpenClawImagePluginProvenance } from "../../state/sandbox";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import { backupSandboxStateForRebuild, type RebuildSandboxEntry } from "./rebuild-flow-helpers";

export type RebuildBackupManifest = Exclude<
  ReturnType<typeof backupSandboxStateForRebuild>,
  undefined
>;

export interface RebuildBackupPhaseInput {
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  staleRecovery: boolean;
  preparedRecoveryManifest: RebuildBackupManifest;
  messagingPlan: SandboxMessagingPlan | null;
  webSearchConfig: WebSearchConfig | null;
  force?: boolean;
  log: RebuildLog;
  bail: RebuildBail;
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean;
}

export interface RebuildBackupPhaseResult {
  backupManifest: RebuildBackupManifest;
  backupWasForceSkipped: boolean;
  policyPresets: string[];
  sessionPolicyPresets: string[] | null;
}

function bailForUnsafeOpenClawPluginProvenance(input: RebuildBackupPhaseInput): never {
  console.error(
    "  Custom-image OpenClaw plugin provenance is missing or invalid; rebuild cannot safely distinguish image-owned plugins from user state.",
  );
  console.error("  The sandbox is untouched — no data was lost.");
  console.error(
    "  To preserve state, onboard the custom image under a new sandbox name and manually migrate only user-owned state.",
  );
  input.relockShieldsIfNeeded(!input.staleRecovery);
  return input.bail("Custom-image OpenClaw plugin provenance is unavailable.");
}

/** Align built-in web-search egress with the durable provider selection. */
export function normalizeRebuildWebSearchPolicyPresets(
  presets: readonly string[],
  sandboxEntry: RebuildSandboxEntry,
  webSearchConfig: WebSearchConfig | null,
): string[] {
  const customPresetNames = new Set(
    (sandboxEntry.customPolicies ?? []).map((policy) => policy.name),
  );
  const selectedProvider = webSearchConfig ? webSearchProviderForConfig(webSearchConfig) : null;
  const preserveStandaloneDcodeTavily =
    selectedProvider === null && sandboxEntry.agent === "langchain-deepagents-code";
  const normalized = presets.filter((name) => {
    // Exact custom content is replayed from backupManifest.customPolicies.
    // Never substitute a same-name built-in during onboard or restore.
    if (customPresetNames.has(name)) return false;
    if (preserveStandaloneDcodeTavily && name === "tavily") return true;
    return !isStaleBuiltinWebSearchPolicyPreset(name, {
      webSearchConfig,
      customPresetNames,
    });
  });
  if (
    selectedProvider &&
    !customPresetNames.has(selectedProvider) &&
    !normalized.includes(selectedProvider)
  ) {
    normalized.push(selectedProvider);
  }
  return [...new Set(normalized)];
}

/** Align built-in observability egress with the durable opt-in and policy tier. */
export function normalizeRebuildObservabilityPolicyPresets(
  presets: readonly string[],
  sandboxEntry: RebuildSandboxEntry,
): string[] {
  const customPresetNames = new Set(
    (sandboxEntry.customPolicies ?? []).map((policy) => policy.name.trim().toLowerCase()),
  );
  const customOwnsObservabilityPolicy = (sandboxEntry.customPolicies ?? []).some((policy) =>
    parsePresetPolicyKeys(policy.content).includes(OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET),
  );
  const customOwnsObservability =
    customPresetNames.has(OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET) || customOwnsObservabilityPolicy;
  const activePresets = presets.filter((name) => {
    const normalizedName = name.trim().toLowerCase();
    if (normalizedName !== OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET) return true;
    // Custom content is replayed separately from the captured manifest. Its
    // registry name may differ from the network-policy key it owns, so neither
    // form may be substituted with the built-in preset.
    if (customOwnsObservability) return false;
    return (
      isDcodeAgent(sandboxEntry.agent) &&
      !isInactiveObservabilityPolicyPreset(name, {
        agent: sandboxEntry.agent,
        observabilityEnabled: sandboxEntry.observabilityEnabled,
        customPresetNames,
      })
    );
  });
  if (!customOwnsObservability) {
    for (const requiredPreset of requiredObservabilityPolicyPresets(
      sandboxEntry.agent,
      sandboxEntry.observabilityEnabled,
    )) {
      if (!activePresets.includes(requiredPreset)) activePresets.push(requiredPreset);
    }
  }
  return filterSuppressedAgentRequiredPresets(
    [...new Set(activePresets)],
    sandboxEntry.policyTier,
    sandboxEntry.agent,
  );
}

/** Normalize the complete replacement target, including fresh inner-onboard additions. */
export function normalizeRebuildTargetPolicyPresets(
  presets: readonly string[],
  sandboxEntry: RebuildSandboxEntry,
  webSearchConfig: WebSearchConfig | null,
): string[] {
  return normalizeRebuildObservabilityPolicyPresets(
    normalizeRebuildWebSearchPolicyPresets([...new Set(presets)], sandboxEntry, webSearchConfig),
    sandboxEntry,
  );
}

export function runRebuildBackupPhase(
  input: RebuildBackupPhaseInput,
  backupStateForRebuild: typeof backupSandboxStateForRebuild = backupSandboxStateForRebuild,
): RebuildBackupPhaseResult | null {
  const customOpenClaw =
    Boolean(input.sandboxEntry.fromDockerfile) &&
    (!input.sandboxEntry.agent || input.sandboxEntry.agent === "openclaw");
  const preparedRecoveryManifest = input.preparedRecoveryManifest;
  const hasPreparedRecovery = preparedRecoveryManifest !== null;
  const preparedRecoveryIsAuthoritative =
    preparedRecoveryManifest !== null &&
    hasAuthoritativeOpenClawImagePluginProvenance(preparedRecoveryManifest);
  const restoresCustomOpenClawState =
    customOpenClaw && (!input.staleRecovery || hasPreparedRecovery);
  if (
    (hasPreparedRecovery &&
      preparedRecoveryManifest?.reconcileOpenClawImagePluginProvenance === true &&
      !preparedRecoveryIsAuthoritative) ||
    (restoresCustomOpenClawState &&
      !preparedRecoveryIsAuthoritative &&
      (hasPreparedRecovery ||
        !hasCompleteOpenClawImagePluginProvenance(
          input.sandboxEntry.openclawImagePluginInstalls,
          "/sandbox/.openclaw",
        )))
  ) {
    return bailForUnsafeOpenClawPluginProvenance(input);
  }
  const backupManifest =
    preparedRecoveryManifest ??
    backupStateForRebuild(
      input.sandboxName,
      input.sandboxEntry,
      input.staleRecovery,
      input.log,
      input.relockShieldsIfNeeded,
      input.bail,
      { force: input.force },
    );
  if (backupManifest === undefined) return null;
  if (
    backupManifest &&
    (backupManifest.reconcileOpenClawImagePluginProvenance === true ||
      restoresCustomOpenClawState) &&
    !hasAuthoritativeOpenClawImagePluginProvenance(backupManifest)
  ) {
    return bailForUnsafeOpenClawPluginProvenance(input);
  }
  const backupWasForceSkipped =
    input.force === true && !input.staleRecovery && backupManifest === null;

  const registryPolicyPresets = Array.isArray(input.sandboxEntry.policies)
    ? input.sandboxEntry.policies.filter(
        (value: unknown): value is string => typeof value === "string",
      )
    : [];
  const disabledChannels = [...(input.messagingPlan?.disabledChannels ?? [])];
  const enabledChannelIds = (input.messagingPlan?.channels ?? [])
    .filter((channel) => !channel.disabled)
    .map((channel) => channel.channelId);
  const mergedPolicyPresets = mergeRebuildMessagingPolicyPresets(
    backupManifest?.policyPresets,
    registryPolicyPresets,
    enabledChannelIds,
    disabledChannels,
  );
  const policyPresets = normalizeRebuildTargetPolicyPresets(
    mergedPolicyPresets,
    input.sandboxEntry,
    input.webSearchConfig,
  );
  const sessionPolicyPresets = resolveRecreatePolicyPresets(
    policyPresets,
    input.sandboxEntry.policyPresetsFinalized === true,
    // Rebuild now replays exact custom policy content after recreate, so the
    // built-in selection can independently preserve an intentional empty set.
    false,
    {},
    true,
  ).policyPresets;

  return { backupManifest, backupWasForceSkipped, policyPresets, sessionPolicyPresets };
}
