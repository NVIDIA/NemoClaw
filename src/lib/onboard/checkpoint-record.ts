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

export function recordCheckpointBindings(
  session: Session,
  additions: {
    registeredProviders?: readonly CheckpointProviderBinding[];
  },
): void {
  const base = baseCheckpoint(session);
  const credentialEnvs = additions.registeredProviders
    ? [
        ...new Set([
          ...base.bindings.credentialEnvs,
          ...additions.registeredProviders.map((binding) => binding.credentialEnv),
        ]),
      ]
    : base.bindings.credentialEnvs;
  const registeredProviders = additions.registeredProviders
    ? [
        ...new Map(
          [...base.bindings.registeredProviders, ...additions.registeredProviders].map(
            (binding) => [binding.name, binding],
          ),
        ).values(),
      ]
    : base.bindings.registeredProviders;
  session.checkpoint = {
    ...base,
    machineState: session.machine.state,
    updatedAt: new Date().toISOString(),
    bindings: { credentialEnvs, registeredProviders },
  };
}
