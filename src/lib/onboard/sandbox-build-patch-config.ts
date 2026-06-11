// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingChannelConfig } from "../messaging-channel-config";
import {
  readMessagingChannelConfigFromEnv,
  resolveMessagingChannelConfigEnvValue,
} from "../messaging-channel-config";
import * as onboardSession from "../state/onboard-session";
import type { Session } from "../state/onboard-session";
import { computeTelegramRequireMention } from "./messaging-config";
import {
  gatherWechatConfig,
  toSessionWechatConfig,
  type WechatConfigSnapshot,
} from "./wechat-config";

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type SandboxBuildPatchChannel = {
  name: string;
  userIdEnvKey?: string;
};

export type SandboxBuildPatchTokenDef = {
  envKey: string;
};

type TelegramConfig = { requireMention?: boolean };

export type MessagingBuildConfig = {
  messagingAllowedIds: Record<string, string[]>;
  discordGuilds: Record<string, { requireMention: boolean; users?: string[] }>;
  slackConfig: Record<string, string[]>;
};

export type SandboxBuildPatchConfig = MessagingBuildConfig & {
  messagingChannelConfig: MessagingChannelConfig | null;
  enabledTokenEnvKeys: Set<string>;
  activeChannelNames: Set<string>;
  telegramConfig: TelegramConfig;
  wechatConfig: WechatConfigSnapshot;
};

export type SandboxBuildPatchConfigDeps = {
  readMessagingChannelConfigFromEnv?(env?: NodeJS.ProcessEnv): MessagingChannelConfig | null;
  collectMessagingBuildConfig?(input: {
    channels: SandboxBuildPatchChannel[];
    activeChannelNames: ReadonlySet<string>;
    enabledTokenEnvKeys: ReadonlySet<string>;
    env?: EnvLike;
    discordSnowflakeRe: RegExp;
    warn?: (message: string) => void;
  }): MessagingBuildConfig;
  computeTelegramRequireMention?(): boolean | null;
  loadSession?(): Session | null;
  gatherWechatConfig?(session: Session | null): WechatConfigSnapshot;
  toSessionWechatConfig?(
    cfg: WechatConfigSnapshot,
  ): { accountId?: string; baseUrl?: string; userId?: string } | null;
  updateSession?(mutator: (session: Session) => Session | void): Session;
};

export type PrepareSandboxBuildPatchConfigInput = {
  channels: SandboxBuildPatchChannel[];
  activeMessagingChannels: readonly string[];
  configuredMessagingChannels?: readonly string[];
  messagingTokenDefs: readonly SandboxBuildPatchTokenDef[];
  discordSnowflakeRe: RegExp;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  deps?: SandboxBuildPatchConfigDeps;
};

function parseMessagingConfigList(value: unknown): string[] {
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
}: {
  channels: SandboxBuildPatchChannel[];
  activeChannelNames: ReadonlySet<string>;
  enabledTokenEnvKeys: ReadonlySet<string>;
  env?: EnvLike;
  discordSnowflakeRe: RegExp;
  warn?: (message: string) => void;
}): MessagingBuildConfig {
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

export function prepareSandboxBuildPatchConfig({
  channels,
  activeMessagingChannels,
  configuredMessagingChannels,
  messagingTokenDefs,
  discordSnowflakeRe,
  env = process.env,
  warn,
  deps = {},
}: PrepareSandboxBuildPatchConfigInput): SandboxBuildPatchConfig {
  const messagingChannelConfig = (
    deps.readMessagingChannelConfigFromEnv ?? readMessagingChannelConfigFromEnv
  )(env);
  const enabledTokenEnvKeys = new Set(messagingTokenDefs.map(({ envKey }) => envKey));
  const activeChannelNames = new Set(activeMessagingChannels);
  const configuredChannelNames = new Set(configuredMessagingChannels ?? activeMessagingChannels);
  const { messagingAllowedIds, discordGuilds, slackConfig } = (
    deps.collectMessagingBuildConfig ?? collectMessagingBuildConfig
  )({
    channels,
    activeChannelNames,
    enabledTokenEnvKeys,
    env,
    discordSnowflakeRe,
    warn,
  });

  const telegramConfig: TelegramConfig = {};
  if (configuredChannelNames.has("telegram")) {
    const telegramRequireMention = (
      deps.computeTelegramRequireMention ?? computeTelegramRequireMention
    )();
    if (telegramRequireMention !== null) {
      telegramConfig.requireMention = telegramRequireMention;
    }
  }

  const loadSession = deps.loadSession ?? onboardSession.loadSession;
  const wechatConfig = (deps.gatherWechatConfig ?? gatherWechatConfig)(loadSession());
  (deps.updateSession ?? onboardSession.updateSession)((current) => {
    current.telegramConfig =
      typeof telegramConfig.requireMention === "boolean"
        ? { requireMention: telegramConfig.requireMention }
        : null;
    current.wechatConfig = (deps.toSessionWechatConfig ?? toSessionWechatConfig)(wechatConfig);
    return current;
  });

  return {
    messagingChannelConfig,
    enabledTokenEnvKeys,
    activeChannelNames,
    messagingAllowedIds,
    discordGuilds,
    slackConfig,
    telegramConfig,
    wechatConfig,
  };
}
