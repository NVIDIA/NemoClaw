// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type MessagingChannelConfig,
  mergeMessagingChannelConfigs,
  resolveMessagingChannelConfigEnvValue,
  sanitizeMessagingChannelConfig,
} from "../messaging-channel-config";
import type { Session } from "../state/onboard-session";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";

type EnvLike = Record<string, string | undefined>;

type MessagingBuildChannel = {
  name: string;
  userIdEnvKey?: string;
};

export type MessagingBuildConfig = {
  messagingAllowedIds: Record<string, string[]>;
  discordGuilds: Record<string, { requireMention: boolean; users?: string[] }>;
  slackConfig: Record<string, string[]>;
};

export type CollectMessagingBuildConfigOptions = {
  channels: MessagingBuildChannel[];
  activeChannelNames: ReadonlySet<string>;
  enabledTokenEnvKeys: ReadonlySet<string>;
  env?: EnvLike;
  discordSnowflakeRe: RegExp;
  warn?: (message: string) => void;
};

// Read TELEGRAM_REQUIRE_MENTION (set either by the interactive mention prompt
// or by the user's shell) and map it to a boolean, or null when the env var
// is unset / invalid. Used at build time to bake groupPolicy into
// openclaw.json and at resume time to detect drift against the recorded
// session state. See #1737 and the CodeRabbit follow-up on #2417.
export function computeTelegramRequireMention(): boolean | null {
  const raw = process.env.TELEGRAM_REQUIRE_MENTION;
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export function parseMessagingConfigList(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((s) => s.replace(/[\r\n]/g, "").trim())
    .filter(Boolean);
}

export function collectMessagingBuildConfig({
  channels,
  activeChannelNames,
  enabledTokenEnvKeys,
  env = process.env,
  discordSnowflakeRe,
  warn = console.warn,
}: CollectMessagingBuildConfigOptions): MessagingBuildConfig {
  const messagingAllowedIds: Record<string, string[]> = {};
  for (const ch of channels) {
    if (activeChannelNames.has(ch.name) && ch.userIdEnvKey) {
      const resolved = resolveMessagingChannelConfigEnvValue(ch.userIdEnvKey, env);
      if (!resolved.value) continue;
      const ids = parseMessagingConfigList(resolved.value);
      if (ids.length > 0) messagingAllowedIds[ch.name] = ids;
    }
  }

  const slackConfig: Record<string, string[]> = {};
  if (activeChannelNames.has("slack") && env.SLACK_ALLOWED_CHANNELS) {
    const allowedChannels = parseMessagingConfigList(env.SLACK_ALLOWED_CHANNELS);
    if (allowedChannels.length > 0) slackConfig.allowedChannels = allowedChannels;
  }

  const discordGuilds: Record<string, { requireMention: boolean; users?: string[] }> = {};
  if (enabledTokenEnvKeys.has("DISCORD_BOT_TOKEN")) {
    const serverIds = parseMessagingConfigList(env.DISCORD_SERVER_IDS || env.DISCORD_SERVER_ID);
    const userIds = parseMessagingConfigList(env.DISCORD_ALLOWED_IDS || env.DISCORD_USER_ID);
    for (const serverId of serverIds) {
      if (!discordSnowflakeRe.test(serverId)) {
        warn("  Warning: configured Discord server ID does not look like a snowflake.");
      }
    }
    for (const userId of userIds) {
      if (!discordSnowflakeRe.test(userId)) {
        warn("  Warning: configured Discord user ID does not look like a snowflake.");
      }
    }
    const requireMention = env.DISCORD_REQUIRE_MENTION !== "0";
    for (const serverId of serverIds) {
      discordGuilds[serverId] = {
        requireMention,
        ...(userIds.length > 0 ? { users: userIds } : {}),
      };
    }
  }

  return { messagingAllowedIds, discordGuilds, slackConfig };
}

export function getStoredMessagingChannelConfig(
  sandboxName: string | null,
  session: Session | null,
): MessagingChannelConfig | null {
  const registryConfig = sandboxName
    ? sanitizeMessagingChannelConfig(registry.getSandbox(sandboxName)?.messagingChannelConfig)
    : null;
  const sessionMatchesSandbox =
    !session?.sandboxName || !sandboxName || session.sandboxName === sandboxName;
  const sessionConfig = sessionMatchesSandbox
    ? sanitizeMessagingChannelConfig(session?.messagingChannelConfig)
    : null;
  return mergeMessagingChannelConfigs(registryConfig, sessionConfig);
}

export function persistMessagingChannelConfigToSession(config: MessagingChannelConfig | null): void {
  onboardSession.updateSession((current: Session) => {
    current.messagingChannelConfig = config;
    return current;
  });
}

export function messagingChannelConfigsEqual(
  left: MessagingChannelConfig | null,
  right: MessagingChannelConfig | null,
): boolean {
  const leftKeys = Object.keys(left || {}).sort();
  const rightKeys = Object.keys(right || {}).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left?.[key] === right?.[key]);
}
