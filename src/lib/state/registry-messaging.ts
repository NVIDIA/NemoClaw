// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../messaging/manifest";
import {
  compactSandboxMessagingPlanForPersistence,
  hydrateDerivedSandboxMessagingPlanFields,
} from "../messaging/persistence";
import {
  getConfiguredChannelIdsFromPlan,
  getDisabledChannelIdsFromPlan,
  parseSandboxMessagingPlan,
} from "../messaging/plan-validation";
import type { SandboxRegistry } from "./registry";

export interface SandboxMessagingState {
  schemaVersion: 1;
  plan: SandboxMessagingPlan;
}

type EntryWithMessaging = {
  messaging?: { schemaVersion?: number; plan?: unknown } | null;
};

export interface RegistryMessagingReadDeps {
  load(): SandboxRegistry;
}

export interface RegistryMessagingMutationDeps extends RegistryMessagingReadDeps {
  save(data: SandboxRegistry): void;
  withLock<T>(fn: () => T): T;
}

export function cloneSandboxMessagingState(
  messaging: SandboxMessagingState | null | undefined,
): SandboxMessagingState | undefined {
  if (!messaging || messaging.schemaVersion !== 1) return undefined;
  const plan = parseSandboxMessagingPlan(messaging.plan);
  return plan ? { schemaVersion: 1, plan } : undefined;
}

export function serializeSandboxMessagingStateForDisk(
  messaging: SandboxMessagingState | null | undefined,
): SandboxMessagingState | undefined {
  const state = cloneSandboxMessagingState(messaging);
  if (!state) return undefined;
  return {
    schemaVersion: 1,
    plan: compactSandboxMessagingPlanForPersistence(state.plan) as unknown as SandboxMessagingPlan,
  };
}

export function getMessagingPlanFromEntry(
  entry: EntryWithMessaging | null | undefined,
): SandboxMessagingPlan | null {
  if (entry?.messaging?.schemaVersion !== 1) return null;
  return parseSandboxMessagingPlan(entry.messaging.plan);
}

export function getHydratedMessagingPlanFromEntry(
  entry: EntryWithMessaging | null | undefined,
): SandboxMessagingPlan | null {
  const plan = getMessagingPlanFromEntry(entry);
  return plan ? hydrateDerivedSandboxMessagingPlanFields(plan) : null;
}

export function getConfiguredMessagingChannelsFromEntry(
  entry: EntryWithMessaging | null | undefined,
): string[] {
  return getConfiguredChannelIdsFromPlan(getMessagingPlanFromEntry(entry));
}

export function getDisabledMessagingChannelsFromEntry(
  entry: EntryWithMessaging | null | undefined,
): string[] {
  return getDisabledChannelIdsFromPlan(getMessagingPlanFromEntry(entry));
}

export function getConfiguredMessagingChannels(
  name: string,
  deps: RegistryMessagingReadDeps,
): string[] {
  const data = deps.load();
  return getConfiguredMessagingChannelsFromEntry(data.sandboxes[name]);
}

export function getDisabledChannels(name: string, deps: RegistryMessagingReadDeps): string[] {
  const data = deps.load();
  return getDisabledMessagingChannelsFromEntry(data.sandboxes[name]);
}

export function setChannelDisabled(
  name: string,
  channelId: string,
  disabled: boolean,
  deps: RegistryMessagingMutationDeps,
): boolean {
  return deps.withLock(() => {
    const data = deps.load();
    const entry = data.sandboxes[name];
    const plan = getMessagingPlanFromEntry(entry);
    if (!entry || !plan) return false;

    const configured = new Set(plan.channels.map((channel) => channel.channelId));
    if (!configured.has(channelId)) return false;

    const disabledChannels = new Set(plan.disabledChannels);
    if (disabled) disabledChannels.add(channelId);
    else disabledChannels.delete(channelId);
    const disabledList = [...disabledChannels].filter((id) => configured.has(id)).sort();
    const disabledSet = new Set(disabledList);

    entry.messaging = {
      schemaVersion: 1,
      plan: {
        ...plan,
        workflow: disabled ? "stop-channel" : "start-channel",
        disabledChannels: disabledList,
        channels: plan.channels.map((channel) => {
          const channelDisabled = disabledSet.has(channel.channelId);
          return {
            ...channel,
            disabled: channelDisabled,
            active: channel.configured && !channelDisabled,
          };
        }),
      },
    };
    deps.save(data);
    return true;
  });
}
