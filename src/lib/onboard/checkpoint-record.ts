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
    bindings.some((binding) => !binding.name || !binding.type || !binding.credentialEnv) ||
    new Set(bindings.map((binding) => binding.name)).size !== bindings.length
  ) {
    throw new Error("provider effect groups contain invalid or duplicate credential bindings");
  }
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
  const nextRegisteredProviders = [
    ...new Map(
      [...base.bindings.registeredProviders, ...registeredProviders].map((binding) => [
        binding.name,
        binding,
      ]),
    ).values(),
  ];
  session.checkpoint = {
    ...base,
    machineState: session.machine.state,
    updatedAt: now,
    effectGroups,
    bindings: {
      credentialEnvs: [
        ...new Set([
          ...base.bindings.credentialEnvs,
          ...registeredProviders.map((binding) => binding.credentialEnv),
        ]),
      ],
      registeredProviders: nextRegisteredProviders,
    },
  };
}
