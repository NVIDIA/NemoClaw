// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../core/json-types";
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
import { normalizeMessagingChannelId } from "./post-agent-install-selection";

export interface SandboxMessagingPlanParseOptions {
  sandboxName?: string | null;
  agent?: MessagingAgentId | string | null;
  supportedChannelIds?: readonly MessagingChannelId[] | readonly string[] | null;
  /** Explicit environment seam for deterministic rehydration without ambient credentials. */
  environment?: Readonly<Record<string, string | undefined>>;
}

export function parseSandboxMessagingPlan(
  value: unknown,
  options: SandboxMessagingPlanParseOptions = {},
): SandboxMessagingPlan | null {
  if (
    !isObjectRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sandboxName !== "string" ||
    typeof value.agent !== "string" ||
    typeof value.workflow !== "string" ||
    !Array.isArray(value.channels) ||
    !Array.isArray(value.disabledChannels) ||
    !isOptionalObjectArray(value, "credentialBindings") ||
    (Object.hasOwn(value, "networkPolicy") && !isObjectRecord(value.networkPolicy)) ||
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

  const supported = Array.isArray(options.supportedChannelIds)
    ? new Set(options.supportedChannelIds)
    : null;
  const normalizedChannelIds = new Set<string>();
  for (const channel of value.channels) {
    if (!isObjectRecord(channel) || typeof channel.channelId !== "string") return null;
    const normalizedChannelId = normalizeMessagingChannelId(channel.channelId);
    if (
      !normalizedChannelId ||
      normalizedChannelId !== channel.channelId ||
      normalizedChannelIds.has(normalizedChannelId)
    ) {
      return null;
    }
    if (Object.hasOwn(channel, "configured") && typeof channel.configured !== "boolean") {
      return null;
    }
    if (Object.hasOwn(channel, "active") && typeof channel.active !== "boolean") return null;
    if (Object.hasOwn(channel, "disabled") && typeof channel.disabled !== "boolean") return null;
    if (
      Object.hasOwn(channel, "pendingRemoval") &&
      typeof channel.pendingRemoval !== "boolean"
    ) {
      return null;
    }
    if (Object.hasOwn(channel, "inputs") && !Array.isArray(channel.inputs)) return null;
    if (Object.hasOwn(channel, "hostForward") && !isHostForward(channel.hostForward)) return null;
    if (Object.hasOwn(channel, "hooks") && !Array.isArray(channel.hooks)) return null;
    if (
      Array.isArray(channel.inputs) &&
      channel.inputs.some(
        (input) =>
          !isObjectRecord(input) ||
          typeof input.inputId !== "string" ||
          (Object.hasOwn(input, "channelId") && input.channelId !== normalizedChannelId),
      )
    ) {
      return null;
    }
    if (
      Array.isArray(channel.hooks) &&
      channel.hooks.some(
        (hook) =>
          !isObjectRecord(hook) ||
          (Object.hasOwn(hook, "channelId") && hook.channelId !== normalizedChannelId),
      )
    ) {
      return null;
    }
    if (
      Object.hasOwn(channel, "hostForward") &&
      isObjectRecord(channel.hostForward) &&
      channel.hostForward.channelId !== normalizedChannelId
    ) {
      return null;
    }
    if (supported && !supported.has(channel.channelId)) return null;
    normalizedChannelIds.add(normalizedChannelId);
  }
  if (!value.disabledChannels.every(isCanonicalMessagingChannelId)) return null;
  const disabledChannelIds = new Set(value.disabledChannels as string[]);
  if (
    disabledChannelIds.size !== value.disabledChannels.length ||
    [...disabledChannelIds].some((channelId) => !normalizedChannelIds.has(channelId)) ||
    value.channels.some(
      (channel) =>
        isObjectRecord(channel) &&
        (channel.disabled === true) !== disabledChannelIds.has(String(channel.channelId)),
    )
  ) {
    return null;
  }
  if (
    !hasCanonicalChannelReferences(value.credentialBindings) ||
    !hasMatchingAgentRenderEntries(value.agentRender, value.agent) ||
    !hasCanonicalChannelReferences(value.agentRender) ||
    !hasCanonicalChannelReferences(value.buildSteps) ||
    !hasCanonicalChannelReferences(value.stateUpdates) ||
    !hasCanonicalChannelReferences(value.healthChecks) ||
    !hasCanonicalNetworkPolicyReferences(value.networkPolicy) ||
    !hasCanonicalRuntimeSetupReferences(value.runtimeSetup)
  ) {
    return null;
  }

  return cloneSandboxMessagingPlan(
    normalizePersistedSandboxMessagingPlanShape(
      value as MaybeCompactMessagingPlan,
      options.environment,
    ),
  );
}

function hasMatchingAgentRenderEntries(value: unknown, agent: string): boolean {
  return (
    !Array.isArray(value) ||
    value.every((render) => isObjectRecord(render) && render.agent === agent)
  );
}

function hasCanonicalNetworkPolicyReferences(value: unknown): boolean {
  if (!isObjectRecord(value) || !Object.hasOwn(value, "entries")) return true;
  return hasCanonicalChannelReferences(value.entries);
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

function isOptionalObjectArray(value: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(value, key)) return true;
  const entries = value[key];
  return Array.isArray(entries) && entries.every(isObjectRecord);
}

function isHostForward(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    typeof value.channelId === "string" &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65535 &&
    typeof value.label === "string"
  );
}

function isRuntimeSetup(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isObjectRecord(value) &&
    Array.isArray(value.nodePreloads) &&
    Array.isArray(value.envAliases) &&
    Array.isArray(value.secretScans) &&
    value.nodePreloads.every(isObjectRecord) &&
    value.envAliases.every(isObjectRecord) &&
    value.secretScans.every(isObjectRecord)
  );
}

function isCanonicalMessagingChannelId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && normalizeMessagingChannelId(value) === value
  );
}

function hasCanonicalChannelReferences(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (entry) => isObjectRecord(entry) && isCanonicalMessagingChannelId(entry.channelId),
      ))
  );
}

function hasCanonicalRuntimeSetupReferences(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObjectRecord(value)) return false;
  return ["nodePreloads", "envAliases", "secretScans"].every((field) =>
    hasCanonicalChannelReferences(value[field]),
  );
}
