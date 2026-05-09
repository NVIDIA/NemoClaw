// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DiscordGuilds, MessagingAllowedIds } from "./build-env.ts";

const CHANNEL_TOKEN_ENVS: Record<string, string[]> = {
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
};

const HERMES_DISCORD_PROXY = "http://127.0.0.1:3129";
const HERMES_DISCORD_FACADE = "http://127.0.0.1:3130";

export function buildMessagingEnvLines(
  enabledChannels: Set<string>,
  allowedIds: MessagingAllowedIds,
  discordGuilds: DiscordGuilds,
): string[] {
  const envLines = ["API_SERVER_PORT=18642", "API_SERVER_HOST=127.0.0.1"];

  for (const channel of enabledChannels) {
    const envKeys = CHANNEL_TOKEN_ENVS[channel] ?? [];
    for (const envKey of envKeys) {
      envLines.push(`${envKey}=openshell:resolve:env:${envKey}`);
    }
    if (channel === "discord") {
      envLines.push(`DISCORD_PROXY=${HERMES_DISCORD_PROXY}`);
      envLines.push(`NEMOCLAW_DISCORD_FACADE_URL=${HERMES_DISCORD_FACADE}`);
      const guildIds = Object.keys(discordGuilds).filter(Boolean);
      if (guildIds.length > 0) {
        envLines.push(`NEMOCLAW_DISCORD_GUILD_IDS=${guildIds.join(",")}`);
      }
    }
  }

  const discordAllowedUsers = collectDiscordAllowedUsers(allowedIds, discordGuilds);
  if (discordAllowedUsers.length > 0) {
    envLines.push(`DISCORD_ALLOWED_USERS=${discordAllowedUsers.join(",")}`);
  }
  if (allowedIds.telegram?.length) {
    envLines.push(`TELEGRAM_ALLOWED_USERS=${allowedIds.telegram.map(String).join(",")}`);
  }

  return envLines;
}

export function buildDiscordConfig(discordGuilds: DiscordGuilds): Record<string, unknown> {
  return {
    require_mention: getDiscordRequireMention(discordGuilds),
    free_response_channels: "",
    allowed_channels: "",
    auto_thread: true,
    reactions: true,
    channel_prompts: {},
  };
}

function getDiscordRequireMention(discordGuilds: DiscordGuilds): boolean {
  for (const guildConfig of Object.values(discordGuilds)) {
    if (typeof guildConfig?.requireMention === "boolean") {
      return guildConfig.requireMention;
    }
  }
  return true;
}

function collectDiscordAllowedUsers(
  allowedIds: MessagingAllowedIds,
  discordGuilds: DiscordGuilds,
): string[] {
  const users = new Set<string>();
  for (const user of allowedIds.discord ?? []) {
    users.add(String(user));
  }
  for (const guildConfig of Object.values(discordGuilds)) {
    for (const user of guildConfig?.users ?? []) {
      users.add(String(user));
    }
  }
  return [...users];
}
