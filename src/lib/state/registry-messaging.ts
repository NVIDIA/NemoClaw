// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../messaging/manifest";
import { parseValidSandboxMessagingPlan } from "../messaging/plan-validation";
import type { SandboxRegistry } from "./registry";

export interface SandboxMessagingState {
  schemaVersion: 1;
  plan: SandboxMessagingPlan;
}

type MessagingEntry = {
  messaging?: { schemaVersion?: number; plan?: SandboxMessagingPlan } | null;
};

export interface RegistryMessagingReadDeps {
  load(): SandboxRegistry;
}

export interface RegistryMessagingMutationDeps extends RegistryMessagingReadDeps {
  save(data: SandboxRegistry): void;
  withLock<T>(fn: () => T): T;
}

export function cloneSandboxMessagingState(
  messaging: SandboxMessagingState | undefined,
): SandboxMessagingState | undefined {
  if (!messaging || messaging.schemaVersion !== 1) return undefined;
  const plan = parseValidSandboxMessagingPlan(messaging.plan);
  if (!plan) return undefined;
  return {
    schemaVersion: 1,
    plan: JSON.parse(JSON.stringify(plan)) as SandboxMessagingPlan,
  };
}

export function getMessagingPlanFromEntry(
  entry: MessagingEntry | null | undefined,
): SandboxMessagingPlan | null {
  const plan = entry?.messaging?.schemaVersion === 1 ? entry.messaging.plan : null;
  return parseValidSandboxMessagingPlan(plan);
}

export function getConfiguredMessagingChannelsFromEntry(
  entry: MessagingEntry | null | undefined,
): string[] {
  const plan = getMessagingPlanFromEntry(entry);
  if (!plan) return [];
  return plan.channels.filter((channel) => channel.configured).map((channel) => channel.channelId);
}

export function getActiveMessagingChannelsFromEntry(
  entry: MessagingEntry | null | undefined,
): string[] {
  const plan = getMessagingPlanFromEntry(entry);
  if (!plan) return [];
  const disabled = new Set(plan.disabledChannels);
  return plan.channels
    .filter((channel) => channel.active && !channel.disabled && !disabled.has(channel.channelId))
    .map((channel) => channel.channelId);
}

export function getDisabledMessagingChannelsFromEntry(
  entry: MessagingEntry | null | undefined,
): string[] {
  const plan = getMessagingPlanFromEntry(entry);
  return plan ? [...plan.disabledChannels] : [];
}

export function getDisabledChannels(name: string, deps: RegistryMessagingReadDeps): string[] {
  const data = deps.load();
  return getDisabledMessagingChannelsFromEntry(data.sandboxes[name]);
}

export function setChannelDisabled(
  name: string,
  channel: string,
  disabled: boolean,
  deps: RegistryMessagingMutationDeps,
): boolean {
  return deps.withLock(() => {
    const data = deps.load();
    const entry = data.sandboxes[name];
    if (!entry) return false;
    const plan = getMessagingPlanFromEntry(entry);
    if (!plan) return false;
    const configuredChannels = new Set(plan.channels.map((entry) => entry.channelId));
    if (!configuredChannels.has(channel)) return false;
    const current = new Set(plan.disabledChannels);
    if (disabled) current.add(channel);
    else current.delete(channel);
    const disabledChannels = Array.from(current)
      .filter((channelId) => configuredChannels.has(channelId))
      .sort();
    const disabledSet = new Set(disabledChannels);
    entry.messaging = {
      schemaVersion: 1,
      plan: {
        ...plan,
        workflow: disabled ? "stop-channel" : "start-channel",
        channels: plan.channels.map((channelPlan) => {
          const channelDisabled = disabledSet.has(channelPlan.channelId);
          return {
            ...channelPlan,
            disabled: channelDisabled,
            active: !channelDisabled && channelPlan.configured,
          };
        }),
        disabledChannels,
      },
    };
    deps.save(data);
    return true;
  });
}

export function getConfiguredMessagingChannels(
  name: string,
  deps: RegistryMessagingReadDeps,
): string[] {
  const data = deps.load();
  return getConfiguredMessagingChannelsFromEntry(data.sandboxes[name]);
}
