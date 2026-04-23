// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deleteCredential, saveCredential } from "./credentials";

export interface ChannelDef {
  envKey: string;
  description: string;
  help: string;
  label: string;
  appTokenEnvKey?: string;
  appTokenHelp?: string;
  appTokenLabel?: string;
  userIdEnvKey?: string;
  userIdHelp?: string;
  userIdLabel?: string;
  allowIdsMode?: "dm" | "guild";
  serverIdEnvKey?: string;
  serverIdHelp?: string;
  serverIdLabel?: string;
  requireMentionEnvKey?: string;
  requireMentionHelp?: string;
}

export const KNOWN_CHANNELS: Record<string, ChannelDef> = {
  telegram: {
    envKey: "TELEGRAM_BOT_TOKEN",
    description: "Telegram bot messaging",
    help: "Create a bot via @BotFather on Telegram, then copy the token.",
    label: "Telegram Bot Token",
    userIdEnvKey: "TELEGRAM_ALLOWED_IDS",
    userIdHelp: "Send /start to @userinfobot on Telegram to get your numeric user ID.",
    userIdLabel: "Telegram User ID (for DM access)",
    allowIdsMode: "dm",
  },
  discord: {
    envKey: "DISCORD_BOT_TOKEN",
    description: "Discord bot messaging",
    help: "Discord Developer Portal → Applications → Bot → Reset/Copy Token.",
    label: "Discord Bot Token",
    serverIdEnvKey: "DISCORD_SERVER_ID",
    serverIdHelp:
      "Enable Developer Mode in Discord, then right-click your server and copy the Server ID.",
    serverIdLabel: "Discord Server ID (for guild workspace access)",
    requireMentionEnvKey: "DISCORD_REQUIRE_MENTION",
    requireMentionHelp:
      "Choose whether the bot should reply only when @mentioned or to all messages in this server.",
    userIdEnvKey: "DISCORD_USER_ID",
    userIdHelp:
      "Optional: enable Developer Mode in Discord, then right-click your user/avatar and copy the User ID. Leave blank to allow any member of the configured server to message the bot.",
    userIdLabel: "Discord User ID (optional guild allowlist)",
    allowIdsMode: "guild",
  },
  slack: {
    envKey: "SLACK_BOT_TOKEN",
    description: "Slack bot messaging",
    help: "Slack API → Your Apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...).",
    label: "Slack Bot Token",
    appTokenEnvKey: "SLACK_APP_TOKEN",
    appTokenHelp: "Slack API → Your Apps → Basic Information → App-Level Tokens (xapp-...).",
    appTokenLabel: "Slack App Token (Socket Mode)",
  },
};

export function getChannelDef(name: string): ChannelDef | undefined {
  return KNOWN_CHANNELS[name.trim().toLowerCase()];
}

export function knownChannelNames(): string[] {
  return Object.keys(KNOWN_CHANNELS);
}

export function listChannels(): Array<{ name: string } & ChannelDef> {
  return Object.entries(KNOWN_CHANNELS).map(([name, def]) => ({ name, ...def }));
}

export function getChannelTokenKeys(channel: ChannelDef): string[] {
  return channel.appTokenEnvKey ? [channel.envKey, channel.appTokenEnvKey] : [channel.envKey];
}

export function persistChannelTokens(tokens: Record<string, string>): void {
  for (const [key, value] of Object.entries(tokens)) {
    saveCredential(key, value);
  }
}

export function clearChannelTokens(channel: ChannelDef): void {
  for (const key of getChannelTokenKeys(channel)) {
    deleteCredential(key);
  }
}
