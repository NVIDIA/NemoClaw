// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../messaging";
import { mergeRebuildMessagingPolicyPresets } from "../../onboard/messaging-policy-presets";
import { resolveRecreatePolicyPresets } from "../../onboard/policy-preset-persistence";
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
  const policyPresets = mergeRebuildMessagingPolicyPresets(
    backupManifest?.policyPresets,
    registryPolicyPresets,
    enabledChannelIds,
    disabledChannels,
  );
  const sessionPolicyPresets = resolveRecreatePolicyPresets(
    policyPresets,
    input.sandboxEntry.policyPresetsFinalized === true,
    (input.sandboxEntry.customPolicies?.length ?? 0) > 0,
    {},
    true,
  ).policyPresets;

  return { backupManifest, policyPresets, sessionPolicyPresets };
}
