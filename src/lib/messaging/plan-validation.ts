// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingChannelConfig } from "../messaging-channel-config";
import type {
  MessagingAgentId,
  MessagingChannelId,
  MessagingSerializableValue,
  SandboxMessagingPlan,
} from "./manifest";
import {
  type MaybeCompactMessagingPlan,
  normalizePersistedSandboxMessagingPlanShape,
} from "./persistence";

export interface SandboxMessagingPlanParseOptions {
  sandboxName?: string | null;
  agent?: MessagingAgentId | string | null;
  supportedChannelIds?: readonly MessagingChannelId[] | readonly string[] | null;
}

export function parseSandboxMessagingPlan(
  value: unknown,
  options: SandboxMessagingPlanParseOptions = {},
): SandboxMessagingPlan | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sandboxName !== "string" ||
    typeof value.agent !== "string" ||
    typeof value.workflow !== "string" ||
    !Array.isArray(value.channels) ||
    !Array.isArray(value.disabledChannels) ||
    !isOptionalObjectArray(value, "credentialBindings") ||
    (Object.hasOwn(value, "networkPolicy") && !isObject(value.networkPolicy)) ||
    !isOptionalObjectArray(value, "agentRender") ||
    !isOptionalObjectArray(value, "buildSteps") ||
    !isRuntimeSetup(value.runtimeSetup) ||
    !isOptionalObjectArray(value, "stateUpdates") ||
    !isOptionalObjectArray(value, "healthChecks")
  ) {
    return null;
  }

  if (options.sandboxName && value.sandboxName !== options.sandboxName) return null;
  if (options.agent && value.agent !== options.agent) return null;

  const supported =
    options.supportedChannelIds && options.supportedChannelIds.length > 0
      ? new Set(options.supportedChannelIds)
      : null;
  for (const [index, channel] of value.channels.entries()) {
    if (!isObject(channel) || typeof channel.channelId !== "string") return null;
    if (Object.hasOwn(channel, "configured") && typeof channel.configured !== "boolean") {
      return null;
    }
    if (Object.hasOwn(channel, "active") && typeof channel.active !== "boolean") return null;
    if (Object.hasOwn(channel, "disabled") && typeof channel.disabled !== "boolean") return null;
    if (Object.hasOwn(channel, "inputs") && !Array.isArray(channel.inputs)) return null;
    if (Object.hasOwn(channel, "hooks") && !Array.isArray(channel.hooks)) return null;
    if (
      Array.isArray(channel.inputs) &&
      channel.inputs.some((input) => !isObject(input) || typeof input.inputId !== "string")
    ) {
      return null;
    }
    if (Array.isArray(channel.hooks) && channel.hooks.some((hook) => !isObject(hook))) {
      return null;
    }
    if (supported && !supported.has(channel.channelId)) return null;
    if (
      value.channels.findIndex(
        (candidate) => isObject(candidate) && candidate.channelId === channel.channelId,
      ) !== index
    ) {
      return null;
    }
  }
  if (!value.disabledChannels.every((channelId) => typeof channelId === "string")) return null;

  return cloneSandboxMessagingPlan(
    normalizePersistedSandboxMessagingPlanShape(value as MaybeCompactMessagingPlan),
  );
}

export function cloneSandboxMessagingPlan(plan: SandboxMessagingPlan): SandboxMessagingPlan {
  return JSON.parse(JSON.stringify(plan)) as SandboxMessagingPlan;
}

export function getConfiguredChannelIdsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] {
  if (!plan) return [];
  return plan.channels.filter((channel) => channel.configured).map((channel) => channel.channelId);
}

export function getActiveChannelIdsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] {
  if (!plan) return [];
  const disabled = new Set(plan.disabledChannels);
  return plan.channels
    .filter((channel) => channel.active && !channel.disabled && !disabled.has(channel.channelId))
    .map((channel) => channel.channelId);
}

export function getDisabledChannelIdsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] {
  return plan ? [...plan.disabledChannels] : [];
}

export function getMessagingChannelConfigFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): MessagingChannelConfig | null {
  if (!plan) return null;
  const config: MessagingChannelConfig = {};
  const stateValues = getMessagingPlanStateValues(plan);

  for (const update of plan.stateUpdates) {
    if (update.kind !== "rebuild-hydration") continue;
    const value = stringifyPlanStateValue(stateValues[update.statePath]);
    if (value) config[update.env] = value;
  }

  for (const channel of plan.channels) {
    for (const input of channel.inputs) {
      if (input.kind !== "config" || !input.sourceEnv || input.value == null) continue;
      if (config[input.sourceEnv]) continue;
      const value = stringifyPlanStateValue(input.value);
      if (value) config[input.sourceEnv] = value;
    }
  }
  return Object.keys(config).length > 0 ? config : null;
}

export function getMessagingPlanStateValues(
  plan: SandboxMessagingPlan | null | undefined,
): Record<string, MessagingSerializableValue> {
  if (!plan) return {};
  const values: Record<string, MessagingSerializableValue> = {};
  for (const channel of plan.channels) {
    for (const input of channel.inputs) {
      if (input.kind !== "config" || !input.statePath || input.value == null) continue;
      values[input.statePath] = input.value;
    }
  }
  return values;
}

function stringifyPlanStateValue(value: MessagingSerializableValue | undefined): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const csv = value
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .join(",");
    return csv || null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalObjectArray(value: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(value, key)) return true;
  const entries = value[key];
  return Array.isArray(entries) && entries.every(isObject);
}

function isRuntimeSetup(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isObject(value) &&
    Array.isArray(value.nodePreloads) &&
    Array.isArray(value.envAliases) &&
    Array.isArray(value.secretScans) &&
    value.nodePreloads.every(isObject) &&
    value.envAliases.every(isObject) &&
    value.secretScans.every(isObject)
  );
}
