// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listMessagingCredentialMetadata } from "../messaging/channels/metadata";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../messaging/provider-profile";
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

/** Collect every active credential binding, including multiple keys owned by one provider. */
export function collectRequiredMessagingProviderBindings(
  sandboxName: string,
  plan: SandboxMessagingPlan | null,
  channelIds?: ReadonlySet<string>,
): CheckpointProviderBinding[] {
  if (!plan) return [];
  const activeChannels = new Set(
    getActiveChannelIdsFromPlan(plan).filter(
      (channelId) => channelIds === undefined || channelIds.has(channelId),
    ),
  );
  const profiles = messagingBridgeProfilesForAgent(plan.agent, listMessagingBridgeProfiles());
  const bindings: CheckpointProviderBinding[] = [];
  for (const binding of plan.credentialBindings) {
    if (!activeChannels.has(binding.channelId)) continue;
    bindings.push({
      name: binding.providerName,
      type:
        staticMessagingProviderTypeForChannel(binding.channelId, plan.agent, profiles) ??
        MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      credentialEnv: binding.providerEnvKey,
    });
  }
  for (const profile of profiles) {
    if (!activeChannels.has(profile.channelId)) continue;
    const name = `${sandboxName}-${profile.channelId}-bridge`;
    if (bindings.some((binding) => binding.name === name)) continue;
    bindings.push({ name, type: profile.profileId, credentialEnv: profile.credentialKey });
  }
  return bindings;
}

/** Replace proven legacy provider names with the current manifest-owned names. */
export function normalizeMessagingProviderBindings(
  sandboxName: string,
  plan: SandboxMessagingPlan,
): SandboxMessagingPlan {
  const providerNamesByCredential = new Map(
    listMessagingCredentialMetadata({ agent: plan.agent }).map((credential) => [
      `${credential.channelId}\0${credential.providerEnvKey}`,
      credential.providerNameTemplate.replaceAll("{sandboxName}", sandboxName),
    ]),
  );
  const currentProviderCredentialEnvs = new Map<string, Set<string>>();
  for (const binding of plan.credentialBindings) {
    const providerName = providerNamesByCredential.get(
      `${binding.channelId}\0${binding.providerEnvKey}`,
    );
    if (providerName !== binding.providerName) continue;
    const key = `${binding.channelId}\0${binding.providerName}`;
    const credentialEnvs = currentProviderCredentialEnvs.get(key) ?? new Set<string>();
    credentialEnvs.add(binding.providerEnvKey);
    currentProviderCredentialEnvs.set(key, credentialEnvs);
  }
  let changed = false;
  const credentialBindings = plan.credentialBindings.map((binding) => {
    const currentProviderName = providerNamesByCredential.get(
      `${binding.channelId}\0${binding.providerEnvKey}`,
    );
    if (!currentProviderName || currentProviderName === binding.providerName) return binding;
    const siblingCredentialEnvs = currentProviderCredentialEnvs.get(
      `${binding.channelId}\0${binding.providerName}`,
    );
    const hasCurrentSibling = [...(siblingCredentialEnvs ?? [])].some(
      (providerEnvKey) => providerEnvKey !== binding.providerEnvKey,
    );
    if (!hasCurrentSibling) return binding;
    changed = true;
    return { ...binding, providerName: currentProviderName };
  });
  return changed ? { ...plan, credentialBindings } : plan;
}

export function requiredMessagingProviderBindings(
  sandboxName: string,
  plan: SandboxMessagingPlan | null,
  channelIds?: ReadonlySet<string>,
): CheckpointProviderBinding[] {
  if (!plan) return [];
  const registrationPlan = normalizeMessagingProviderBindings(sandboxName, plan);
  const bindings = new Map<string, CheckpointProviderBinding>();
  for (const binding of collectRequiredMessagingProviderBindings(
    sandboxName,
    registrationPlan,
    channelIds,
  )) {
    bindings.set(binding.name, binding);
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
