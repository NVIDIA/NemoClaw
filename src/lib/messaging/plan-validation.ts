// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingChannelConfig } from "../messaging-channel-config";
import { createBuiltInChannelManifestRegistry } from "./channels";
import type {
  ChannelInputSpec,
  ChannelManifest,
  MessagingAgentId,
  MessagingChannelId,
  MessagingSerializableValue,
  SandboxMessagingPlan,
} from "./manifest";
import {
  type MaybeCompactMessagingPlan,
  normalizePersistedSandboxMessagingPlanShape,
} from "./persistence";

let cachedBuiltInManifestsById: Map<string, ChannelManifest> | null = null;

function builtInManifestsById(): Map<string, ChannelManifest> {
  if (!cachedBuiltInManifestsById) {
    cachedBuiltInManifestsById = new Map(
      createBuiltInChannelManifestRegistry()
        .list()
        .map((manifest) => [manifest.id, manifest]),
    );
  }
  return cachedBuiltInManifestsById;
}

function manifestInputById(
  manifest: ChannelManifest,
  inputId: string,
): ChannelInputSpec | undefined {
  return manifest.inputs.find((input) => input.id === inputId);
}

function persistedValueAllowedByManifest(
  input: ChannelInputSpec,
  value: MessagingSerializableValue,
): boolean {
  if (input.kind !== "config") return true;
  if (!input.validValues || input.validValues.length === 0) return true;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return false;
  }
  const text = typeof value === "string" ? value : String(value);
  return input.validValues.includes(text);
}

export function sanitizePersistedManifestValues(plan: SandboxMessagingPlan): SandboxMessagingPlan {
  const manifests = builtInManifestsById();
  let mutated = false;
  const channels = plan.channels.map((channel) => {
    const manifest = manifests.get(channel.channelId);
    if (!manifest) return channel;
    let channelMutated = false;
    const inputs = channel.inputs.map((entry) => {
      if (entry.kind !== "config" || entry.value === undefined || entry.value === null) {
        return entry;
      }
      const spec = manifestInputById(manifest, entry.inputId);
      if (!spec || persistedValueAllowedByManifest(spec, entry.value)) return entry;
      channelMutated = true;
      mutated = true;
      const { value: _dropped, ...rest } = entry;
      return rest;
    });
    return channelMutated ? { ...channel, inputs } : channel;
  });
  return mutated ? { ...plan, channels } : plan;
}

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

  const supported = Array.isArray(options.supportedChannelIds)
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
    if (Object.hasOwn(channel, "hostForward") && !isHostForward(channel.hostForward)) return null;
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
  const sanitized = sanitizePersistedManifestValues(plan);
  const config: MessagingChannelConfig = {};
  const stateValues = getMessagingPlanStateValues(sanitized);

  for (const update of sanitized.stateUpdates) {
    if (update.kind !== "rebuild-hydration") continue;
    const value = stringifyPlanStateValue(stateValues[update.statePath]);
    if (value) config[update.env] = value;
  }

  for (const channel of sanitized.channels) {
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

function isHostForward(value: unknown): boolean {
  return (
    isObject(value) &&
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
    isObject(value) &&
    Array.isArray(value.nodePreloads) &&
    Array.isArray(value.envAliases) &&
    Array.isArray(value.secretScans) &&
    value.nodePreloads.every(isObject) &&
    value.envAliases.every(isObject) &&
    value.secretScans.every(isObject)
  );
}
