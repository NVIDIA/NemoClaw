// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import {
  getActiveChannelIdsFromPlan,
  getDisabledChannelIdsFromPlan,
} from "../messaging/plan-validation";
import { decisionDeclined, decisionSelected } from "../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import type {
  CheckpointEffectGroupName,
  CheckpointProviderBinding,
  CheckpointResourceProfile,
  OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";
import type { Session } from "../state/onboard-session";

function baseCheckpoint(session: Session): OnboardCheckpoint {
  return session.checkpoint ?? deriveCheckpointFromSession(session);
}

type ProviderEffectGroupName = Extract<
  CheckpointEffectGroupName,
  "web_search_provider" | "messaging_providers"
>;

function assertValidProviderBindings(bindings: readonly CheckpointProviderBinding[]): void {
  if (
    bindings.some(
      (binding) =>
        !binding.name ||
        !binding.type ||
        !binding.credentialEnv ||
        binding.name.trim() !== binding.name ||
        binding.type.trim() !== binding.type ||
        binding.credentialEnv.trim() !== binding.credentialEnv,
    ) ||
    new Set(bindings.map((binding) => binding.name)).size !== bindings.length
  ) {
    throw new Error("provider effect groups contain invalid or duplicate credential bindings");
  }
}

function checkpointProviderEffectGroupNames(
  checkpoint: OnboardCheckpoint,
  group: ProviderEffectGroupName,
): readonly string[] {
  const receipt = checkpoint.effectGroups[group];
  if (!receipt) return [];
  const names = receipt.fingerprint.split(",");
  if (
    !receipt.fingerprint ||
    names.some((name) => !name || name.trim() !== name) ||
    names.join(",") !== receipt.fingerprint ||
    new Set(names).size !== names.length
  ) {
    throw new Error("provider effect group receipt contains invalid or duplicate provider names");
  }
  return names;
}

export function recordCheckpointSandboxIdentity(
  session: Session,
  name: string,
  agent: string,
): void {
  const base = baseCheckpoint(session);
  session.checkpoint = {
    ...base,
    machineState: session.machine.state,
    updatedAt: new Date().toISOString(),
    sandboxIdentity: decisionSelected({ name, agent }),
  };
}

export function recordCheckpointEffectGroup(
  session: Session,
  group: CheckpointEffectGroupName,
  fingerprint: string,
): void {
  const base = baseCheckpoint(session);
  const now = new Date().toISOString();
  session.checkpoint = {
    ...base,
    machineState: session.machine.state,
    updatedAt: now,
    effectGroups: {
      ...base.effectGroups,
      [group]: { completedAt: now, fingerprint },
    },
  };
}

export function recordCheckpointWebSearch(
  session: Session,
  webSearchConfig: WebSearchConfig | null,
): void {
  const base = baseCheckpoint(session);
  session.checkpoint = {
    ...base,
    machineState: session.machine.state,
    updatedAt: new Date().toISOString(),
    webSearch: webSearchConfig ? decisionSelected(webSearchConfig) : decisionDeclined(),
  };
}

export function recordCheckpointMessaging(
  session: Session,
  messagingPlan: SandboxMessagingPlan | null,
): void {
  const base = baseCheckpoint(session);
  session.checkpoint = {
    ...base,
    machineState: session.machine.state,
    updatedAt: new Date().toISOString(),
    messaging: messagingPlan
      ? decisionSelected({
          selectedChannels: getActiveChannelIdsFromPlan(messagingPlan),
          disabledChannels: getDisabledChannelIdsFromPlan(messagingPlan),
        })
      : decisionDeclined(),
  };
}

export function recordCheckpointResourceProfile(
  session: Session,
  resourceProfile: CheckpointResourceProfile | null,
): void {
  const base = baseCheckpoint(session);
  session.checkpoint = {
    ...base,
    machineState: session.machine.state,
    updatedAt: new Date().toISOString(),
    resourceProfile: resourceProfile ? decisionSelected(resourceProfile) : decisionDeclined(),
  };
}

export function recordCheckpointProviderEffectGroups(
  session: Session,
  providerGroups: {
    readonly webSearch: readonly CheckpointProviderBinding[];
    readonly messaging: readonly CheckpointProviderBinding[];
  },
): void {
  const base = baseCheckpoint(session);
  const nextRegisteredProviders = [...providerGroups.webSearch, ...providerGroups.messaging];
  assertValidProviderBindings(nextRegisteredProviders);
  const credentialEnvs = [
    ...new Set(nextRegisteredProviders.map((binding) => binding.credentialEnv)),
  ];
  const now = new Date().toISOString();
  const {
    web_search_provider: _previousWebSearch,
    messaging_providers: _previousMessaging,
    ...otherEffectGroups
  } = base.effectGroups;
  session.checkpoint = {
    ...base,
    machineState: session.machine.state,
    updatedAt: now,
    effectGroups: {
      ...otherEffectGroups,
      ...(providerGroups.webSearch.length > 0
        ? {
            web_search_provider: {
              completedAt: now,
              fingerprint: providerGroups.webSearch.map((binding) => binding.name).join(","),
            },
          }
        : {}),
      ...(providerGroups.messaging.length > 0
        ? {
            messaging_providers: {
              completedAt: now,
              fingerprint: providerGroups.messaging.map((binding) => binding.name).join(","),
            },
          }
        : {}),
    },
    bindings: { credentialEnvs, registeredProviders: nextRegisteredProviders },
  };
}

export function recordCheckpointProviderEffectGroup(
  session: Session,
  group: ProviderEffectGroupName,
  registeredProviders: readonly CheckpointProviderBinding[],
): void {
  assertValidProviderBindings(registeredProviders);
  const base = baseCheckpoint(session);
  assertValidProviderBindings(base.bindings.registeredProviders);
  const otherGroup: ProviderEffectGroupName =
    group === "web_search_provider" ? "messaging_providers" : "web_search_provider";
  const previousGroupNames = checkpointProviderEffectGroupNames(base, group);
  const otherGroupNames = checkpointProviderEffectGroupNames(base, otherGroup);
  const ownedProviderNames = [...previousGroupNames, ...otherGroupNames];
  if (new Set(ownedProviderNames).size !== ownedProviderNames.length) {
    throw new Error("provider effect group receipts contain conflicting provider ownership");
  }
  const recordedProviderNames = new Set(
    base.bindings.registeredProviders.map((binding) => binding.name),
  );
  if (ownedProviderNames.some((name) => !recordedProviderNames.has(name))) {
    throw new Error("provider effect group receipt does not match registered credential bindings");
  }
  const previousGroupNameSet = new Set(previousGroupNames);
  const otherGroupNameSet = new Set(otherGroupNames);
  const registeredProviderNameSet = new Set(registeredProviders.map((binding) => binding.name));
  if (registeredProviders.some((binding) => otherGroupNameSet.has(binding.name))) {
    throw new Error("provider effect group conflicts with another group's provider ownership");
  }
  const previousGroupBindings = base.bindings.registeredProviders.filter((binding) =>
    previousGroupNameSet.has(binding.name),
  );
  const adoptedProviderBindings = base.bindings.registeredProviders.filter(
    (binding) =>
      !previousGroupNameSet.has(binding.name) &&
      !otherGroupNameSet.has(binding.name) &&
      registeredProviderNameSet.has(binding.name),
  );
  const adoptedProviderNameSet = new Set(adoptedProviderBindings.map((binding) => binding.name));
  const remainingProviderBindings = base.bindings.registeredProviders.filter(
    (binding) =>
      !previousGroupNameSet.has(binding.name) && !adoptedProviderNameSet.has(binding.name),
  );
  const nextRegisteredProviders = [...remainingProviderBindings, ...registeredProviders];
  assertValidProviderBindings(nextRegisteredProviders);
  const replacedCredentialEnvs = new Set(
    [...previousGroupBindings, ...adoptedProviderBindings].map((binding) => binding.credentialEnv),
  );
  const now = new Date().toISOString();
  const effectGroups = { ...base.effectGroups };
  if (registeredProviders.length > 0) {
    effectGroups[group] = {
      completedAt: now,
      fingerprint: registeredProviders.map((binding) => binding.name).join(","),
    };
  } else {
    delete effectGroups[group];
  }
  session.checkpoint = {
    ...base,
    machineState: session.machine.state,
    updatedAt: now,
    effectGroups,
    bindings: {
      credentialEnvs: [
        ...new Set([
          ...base.bindings.credentialEnvs.filter((env) => !replacedCredentialEnvs.has(env)),
          ...nextRegisteredProviders.map((binding) => binding.credentialEnv),
        ]),
      ],
      registeredProviders: nextRegisteredProviders,
    },
  };
}
