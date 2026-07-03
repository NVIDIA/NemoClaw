// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../messaging";
import { type WebSearchConfig, webSearchProviderForConfig } from "../../inference/web-search";
import { mergeRebuildMessagingPolicyPresets } from "../../onboard/messaging-policy-presets";
import { resolveRecreatePolicyPresets } from "../../onboard/policy-preset-persistence";
import { isStaleBuiltinWebSearchPolicyPreset } from "../../onboard/policy-selection";
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
  log: RebuildLog;
  bail: RebuildBail;
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean;
}

export interface RebuildBackupPhaseResult {
  backupManifest: RebuildBackupManifest;
  policyPresets: string[];
  sessionPolicyPresets: string[] | null;
}

export function runRebuildBackupPhase(
  input: RebuildBackupPhaseInput,
): RebuildBackupPhaseResult | null {
  const backupManifest =
    input.preparedRecoveryManifest ??
    backupSandboxStateForRebuild(
      input.sandboxName,
      input.sandboxEntry,
      input.staleRecovery,
      input.log,
      input.relockShieldsIfNeeded,
      input.bail,
    );
  if (backupManifest === undefined) return null;

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
  const customPresetNames = new Set(
    (input.sandboxEntry.customPolicies ?? []).map((policy) => policy.name),
  );
  const policyPresets = mergedPolicyPresets.filter(
    (name) =>
      !isStaleBuiltinWebSearchPolicyPreset(name, {
        webSearchConfig: input.webSearchConfig,
        customPresetNames,
      }) && !(customPresetNames.has(name) && ["brave", "tavily", "nous-web"].includes(name)),
  );
  if (input.webSearchConfig) {
    const activePreset = webSearchProviderForConfig(input.webSearchConfig);
    if (!customPresetNames.has(activePreset) && !policyPresets.includes(activePreset)) {
      policyPresets.push(activePreset);
    }
  }
  const sessionPolicyPresets = resolveRecreatePolicyPresets(
    policyPresets,
    input.sandboxEntry.policyPresetsFinalized === true,
    (input.sandboxEntry.customPolicies?.length ?? 0) > 0,
    {},
    true,
  ).policyPresets;

  return { backupManifest, policyPresets, sessionPolicyPresets };
}
