// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { BUILT_IN_CHANNEL_MANIFESTS, getMessagingConfigEnvAliases } from "./messaging/channels";
import { listChannels } from "./sandbox/channels";

export type MessagingChannelConfig = Record<string, string>;

const channels = listChannels();
const manifestConfigInputs = BUILT_IN_CHANNEL_MANIFESTS.flatMap((manifest) =>
  manifest.inputs
    .filter((input) => input.kind === "config")
    .map((input) => ({
      envKey: input.envKey,
      validValues: "validValues" in input ? input.validValues : undefined,
    })),
);
const requireMentionKeys = new Set(
  [
    ...channels.map((channel) => channel.requireMentionEnvKey),
    ...manifestConfigInputs.filter(hasBooleanStringValues).map((input) => input.envKey),
  ].filter((key): key is string => typeof key === "string" && key.length > 0),
);

const configKeyAliases = getMessagingConfigEnvAliases();

const aliasToCanonical = new Map(
  Object.entries(configKeyAliases).flatMap(([canonical, aliases]) =>
    aliases.map((alias) => [alias, canonical] as const),
  ),
);

export const MESSAGING_CHANNEL_CONFIG_ENV_KEYS: readonly string[] = [
  ...new Set(
    [
      ...channels.flatMap((channel) => [
        channel.serverIdEnvKey,
        channel.userIdEnvKey,
        channel.channelIdEnvKey,
        channel.requireMentionEnvKey,
      ]),
      ...manifestConfigInputs.map((input) => input.envKey),
      ...BUILT_IN_CHANNEL_MANIFESTS.flatMap(
        (manifest) => manifest.state.rebuildHydration?.map((hydration) => hydration.env) ?? [],
      ),
    ].filter((key): key is string => typeof key === "string" && key.length > 0),
  ),
];

const knownConfigKeys = new Set(MESSAGING_CHANNEL_CONFIG_ENV_KEYS);

function hasBooleanStringValues(input: { readonly validValues?: readonly string[] }): boolean {
  return input.validValues?.includes("0") === true && input.validValues.includes("1");
}

export type MessagingChannelConfigEnvResolution = {
  canonicalKey: string | null;
  sourceKey: string | null;
  value: string | null;
};

function normalizeValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/[\r\n]/.test(value)) {
    throw new Error("Messaging channel config values must not contain line breaks.");
  }
  const normalized = value.trim();
  return normalized || null;
}

export function getCanonicalMessagingChannelConfigKey(key: string): string | null {
  return knownConfigKeys.has(key) ? key : (aliasToCanonical.get(key) ?? null);
}

export function getMessagingChannelConfigEnvKeys(key: string): readonly string[] {
  const canonical = getCanonicalMessagingChannelConfigKey(key);
  if (!canonical) return [];
  return [canonical, ...(configKeyAliases[canonical] ?? [])];
}

export function normalizeMessagingChannelConfigValue(key: string, value: unknown): string | null {
  const canonical = getCanonicalMessagingChannelConfigKey(key);
  if (!canonical) return null;
  const normalized = normalizeValue(value);
  if (!normalized) return null;
  if (requireMentionKeys.has(canonical) && normalized !== "0" && normalized !== "1") {
    return null;
  }
  return normalized;
}

export function resolveMessagingChannelConfigEnvValue(
  key: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): MessagingChannelConfigEnvResolution {
  const canonical = getCanonicalMessagingChannelConfigKey(key);
  if (!canonical) return { canonicalKey: null, sourceKey: null, value: null };
  for (const candidate of getMessagingChannelConfigEnvKeys(canonical)) {
    const normalized = normalizeMessagingChannelConfigValue(canonical, env[candidate]);
    if (normalized) {
      return { canonicalKey: canonical, sourceKey: candidate, value: normalized };
    }
  }
  return { canonicalKey: canonical, sourceKey: null, value: null };
}

export function sanitizeMessagingChannelConfig(value: unknown): MessagingChannelConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const result: MessagingChannelConfig = {};
  const rawConfig = value as Record<string, unknown>;
  for (const key of MESSAGING_CHANNEL_CONFIG_ENV_KEYS) {
    const normalized = normalizeMessagingChannelConfigValue(key, rawConfig[key]);
    if (normalized) result[key] = normalized;
  }
  for (const [key, raw] of Object.entries(rawConfig)) {
    const canonical = getCanonicalMessagingChannelConfigKey(key);
    if (!canonical || result[canonical]) continue;
    const normalized = normalizeMessagingChannelConfigValue(canonical, raw);
    if (normalized) result[canonical] = normalized;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function mergeMessagingChannelConfigs(
  ...configs: Array<MessagingChannelConfig | null | undefined>
): MessagingChannelConfig | null {
  const merged: MessagingChannelConfig = {};
  for (const config of configs) {
    const sanitized = sanitizeMessagingChannelConfig(config);
    if (!sanitized) continue;
    Object.assign(merged, sanitized);
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

export function readMessagingChannelConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MessagingChannelConfig | null {
  const result: MessagingChannelConfig = {};
  for (const key of MESSAGING_CHANNEL_CONFIG_ENV_KEYS) {
    const resolved = resolveMessagingChannelConfigEnvValue(key, env);
    if (resolved.value) result[key] = resolved.value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function hydrateMessagingChannelConfig(
  config: MessagingChannelConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MessagingChannelConfig | null {
  const sanitized = sanitizeMessagingChannelConfig(config);
  const effective: MessagingChannelConfig = {};
  for (const key of MESSAGING_CHANNEL_CONFIG_ENV_KEYS) {
    const envValue = resolveMessagingChannelConfigEnvValue(key, env);
    if (envValue.value) {
      if (!env[key]) env[key] = envValue.value;
      effective[key] = envValue.value;
      continue;
    }
    const storedValue = sanitized ? sanitized[key] : null;
    if (storedValue) {
      env[key] = storedValue;
      effective[key] = storedValue;
    }
  }
  return Object.keys(effective).length > 0 ? effective : null;
}
