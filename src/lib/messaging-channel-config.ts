// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listChannels } from "./sandbox/channels";

export type MessagingChannelConfig = Record<string, string>;

const channels = listChannels();
const requireMentionKeys = new Set(
  channels
    .map((channel) => channel.requireMentionEnvKey)
    .filter((key): key is string => typeof key === "string" && key.length > 0),
);

export const MESSAGING_CHANNEL_CONFIG_ENV_KEYS: readonly string[] = [
  ...new Set(
    channels.flatMap((channel) =>
      [channel.serverIdEnvKey, channel.userIdEnvKey, channel.requireMentionEnvKey].filter(
        (key): key is string => typeof key === "string" && key.length > 0,
      ),
    ),
  ),
];

const knownConfigKeys = new Set(MESSAGING_CHANNEL_CONFIG_ENV_KEYS);

function normalizeValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r/g, "").trim();
  return normalized || null;
}

export function normalizeMessagingChannelConfigValue(
  key: string,
  value: unknown,
): string | null {
  if (!knownConfigKeys.has(key)) return null;
  const normalized = normalizeValue(value);
  if (!normalized) return null;
  if (requireMentionKeys.has(key) && normalized !== "0" && normalized !== "1") {
    return null;
  }
  return normalized;
}

export function sanitizeMessagingChannelConfig(value: unknown): MessagingChannelConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const result: MessagingChannelConfig = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = normalizeMessagingChannelConfigValue(key, raw);
    if (normalized) result[key] = normalized;
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
    const normalized = normalizeMessagingChannelConfigValue(key, env[key]);
    if (normalized) result[key] = normalized;
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
    const envValue = normalizeMessagingChannelConfigValue(key, env[key]);
    if (envValue) {
      effective[key] = envValue;
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
