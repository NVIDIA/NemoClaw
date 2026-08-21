// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../messaging/manifest";
import { getActiveChannelIdsFromPlan } from "../messaging/plan-validation";
import { isDecisionSelected } from "../state/onboard-checkpoint-decision";
import type {
  CheckpointEffectGroupName,
  CheckpointProviderBinding,
  CheckpointSandboxIdentity,
  OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";
import { HERMES_TAVILY_PROVIDER_PROFILE_ID } from "./brave-provider-profile";
import type { OnboardMachineState } from "./machine/types";
import { ONBOARD_MACHINE_STATES } from "./machine/types";
import {
  listMessagingBridgeProfiles,
  messagingBridgeProfilesForAgent,
  staticMessagingProviderTypeForChannel,
} from "./messaging-bridge-provider";

export interface CheckpointedMachineSession {
  readonly checkpoint: OnboardCheckpoint | null;
  readonly machine: { readonly state: OnboardMachineState };
}

export function checkpointSandboxIdentityMatches(
  session:
    | (CheckpointedMachineSession & {
        readonly sandboxName?: string | null;
        readonly sandboxPromptProgress?: { readonly sandboxName?: boolean };
      })
    | null
    | undefined,
  sandboxName: string,
): boolean {
  if (session?.checkpoint) {
    return (
      isDecisionSelected(session.checkpoint.sandboxIdentity) &&
      session.checkpoint.sandboxIdentity.value.name === sandboxName
    );
  }
  return (
    session?.sandboxPromptProgress?.sandboxName === true && session.sandboxName === sandboxName
  );
}

export function checkpointProvesSandboxStepComplete(
  session: CheckpointedMachineSession | null | undefined,
): boolean {
  if (!session?.checkpoint) return false;
  const sandboxIndex = ONBOARD_MACHINE_STATES.indexOf("sandbox");
  const stateIndex = ONBOARD_MACHINE_STATES.indexOf(session.machine.state);
  return stateIndex > sandboxIndex;
}

export type EffectGroupReplayReason =
  | "not_recorded"
  | "postcondition_failed"
  | "fingerprint_mismatch"
  | "already_complete_revalidated";

export interface EffectGroupReplayDecision {
  readonly group: CheckpointEffectGroupName;
  readonly action: "skip" | "run";
  readonly reason: EffectGroupReplayReason;
}

export function planEffectGroupReplay(
  checkpoint: OnboardCheckpoint,
  group: CheckpointEffectGroupName,
  observedFingerprint: string | null,
): EffectGroupReplayDecision {
  const record = checkpoint.effectGroups[group];
  if (!record) return { group, action: "run", reason: "not_recorded" };
  if (!observedFingerprint) return { group, action: "run", reason: "postcondition_failed" };
  if (observedFingerprint !== record.fingerprint) {
    return { group, action: "run", reason: "fingerprint_mismatch" };
  }
  return { group, action: "skip", reason: "already_complete_revalidated" };
}

export function observeProviderEffectFingerprint(
  checkpoint: OnboardCheckpoint,
  group: CheckpointEffectGroupName,
  requiredBindings: readonly CheckpointProviderBinding[],
  bindingMatches: (
    binding: OnboardCheckpoint["bindings"]["registeredProviders"][number],
  ) => boolean,
): string | null {
  const fingerprint = checkpoint.effectGroups[group]?.fingerprint;
  const providerNames = fingerprint?.split(",").filter(Boolean) ?? [];
  if (
    !fingerprint ||
    providerNames.length === 0 ||
    providerNames.join(",") !== fingerprint ||
    providerNames.length !== requiredBindings.length
  ) {
    return null;
  }
  const receiptNames = new Set(providerNames);
  const requiredBindingsByName = new Map(
    requiredBindings.map((binding) => [binding.name, binding]),
  );
  if (
    receiptNames.size !== providerNames.length ||
    requiredBindingsByName.size !== requiredBindings.length
  ) {
    return null;
  }
  const receiptBindings = checkpoint.bindings.registeredProviders.filter((binding) =>
    receiptNames.has(binding.name),
  );
  if (receiptBindings.length !== providerNames.length) return null;
  const bindingsByName = new Map(receiptBindings.map((binding) => [binding.name, binding]));
  for (const name of providerNames) {
    const binding = bindingsByName.get(name);
    const required = requiredBindingsByName.get(name);
    if (
      !binding ||
      !required ||
      binding.type !== required.type ||
      binding.credentialEnv !== required.credentialEnv ||
      !bindingMatches(binding)
    ) {
      return null;
    }
  }
  return fingerprint;
}

export function requiredWebSearchProviderType(
  provider: "brave" | "tavily",
  agent: { name?: string } | null,
): string {
  return provider === "tavily" && agent?.name?.trim().toLowerCase() === "hermes"
    ? HERMES_TAVILY_PROVIDER_PROFILE_ID
    : provider;
}

export function requiredMessagingProviderBindings(
  sandboxName: string,
  plan: SandboxMessagingPlan | null,
): CheckpointProviderBinding[] {
  if (!plan) return [];
  const activeChannels = new Set(getActiveChannelIdsFromPlan(plan));
  const profiles = messagingBridgeProfilesForAgent(plan.agent, listMessagingBridgeProfiles());
  const bindings = new Map<string, CheckpointProviderBinding>();
  for (const binding of plan.credentialBindings) {
    if (!activeChannels.has(binding.channelId)) continue;
    bindings.set(binding.providerName, {
      name: binding.providerName,
      type:
        staticMessagingProviderTypeForChannel(binding.channelId, plan.agent, profiles) ?? "generic",
      credentialEnv: binding.providerEnvKey,
    });
  }
  for (const profile of profiles) {
    if (!activeChannels.has(profile.channelId)) continue;
    const name = `${sandboxName}-${profile.channelId}-bridge`;
    const existing = bindings.get(name);
    bindings.set(
      name,
      existing
        ? { ...existing, type: profile.profileId }
        : { name, type: profile.profileId, credentialEnv: profile.credentialKey },
    );
  }
  return [...bindings.values()];
}

export interface SandboxCreateObservation {
  readonly liveSandboxExists: boolean;
}

export type SandboxCreateReplayDecision =
  | { readonly action: "reuse"; readonly identity: CheckpointSandboxIdentity }
  | { readonly action: "create"; readonly identity: CheckpointSandboxIdentity }
  | { readonly action: "capture_identity_first" };

export function planSandboxCreateReplay(
  checkpoint: OnboardCheckpoint,
  observed: SandboxCreateObservation,
): SandboxCreateReplayDecision {
  if (!isDecisionSelected(checkpoint.sandboxIdentity)) {
    return { action: "capture_identity_first" };
  }
  const identity = checkpoint.sandboxIdentity.value;
  if (observed.liveSandboxExists) {
    return { action: "reuse", identity };
  }
  return { action: "create", identity };
}
