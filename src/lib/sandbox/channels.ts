// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deleteCredential, saveCredential } from "../credentials/store";

export interface ChannelBase {
  description: string;
  help: string;
  label: string;
  setupNotes?: readonly string[];
  userIdEnvKey?: string;
  userIdHelp?: string;
  userIdLabel?: string;
  allowIdsMode?: "dm" | "guild";
  channelIdEnvKey?: string;
  channelIdHelp?: string;
  channelIdLabel?: string;
  serverIdEnvKey?: string;
  serverIdHelp?: string;
  serverIdLabel?: string;
  requireMentionEnvKey?: string;
  requireMentionHelp?: string;
}

export interface CredentialBackedChannelDef extends ChannelBase {
  envKey?: string;
  appTokenEnvKey?: string;
  appTokenHelp?: string;
  appTokenLabel?: string;
  tokenFormat?: RegExp;
  tokenFormatHint?: string;
  appTokenFormat?: RegExp;
  appTokenFormatHint?: string;
  // "host-qr" channels capture a static token via a host-side QR handshake
  // (e.g. wechat/iLink). Defaults to "token-paste" when omitted.
  loginMethod?: "token-paste" | "host-qr";
}

export interface InSandboxQrChannelDef extends ChannelBase {
  // In-sandbox QR channels intentionally let the bot library own mutable
  // session state inside the sandbox after the operator pairs the account.
  // That is the runtime tradeoff of enabling the channel without a host bridge;
  // NemoClaw must still not declare host-side token env keys or OpenShell
  // provider credentials for these channels.
  loginMethod: "in-sandbox-qr";
  envKey?: never;
  appTokenEnvKey?: never;
  appTokenHelp?: never;
  appTokenLabel?: never;
  tokenFormat?: never;
  tokenFormatHint?: never;
  appTokenFormat?: never;
  appTokenFormatHint?: never;
}

export type ChannelDef = CredentialBackedChannelDef | InSandboxQrChannelDef;

export const KNOWN_CHANNELS: Record<string, ChannelDef> = {
  telegram: {
    envKey: "TELEGRAM_BOT_TOKEN",
    description: "Telegram bot messaging",
    help: "Create a bot via @BotFather on Telegram, then copy the token.",
    label: "Telegram Bot Token",
    setupNotes: [
      "For Telegram group chats, disable privacy mode in @BotFather (/setprivacy -> your bot -> Disable).",
      "After changing privacy mode, remove and re-add the bot to each group before testing @mentions.",
    ],
    userIdEnvKey: "TELEGRAM_ALLOWED_IDS",
    userIdHelp: "Send /start to @userinfobot on Telegram to get your numeric user ID.",
    userIdLabel: "Telegram User ID (for DM access)",
    allowIdsMode: "dm",
    requireMentionEnvKey: "TELEGRAM_REQUIRE_MENTION",
    requireMentionHelp:
      "Controls Telegram group-chat behavior only — reply only when @mentioned vs. to all group messages. Direct messages are unaffected by this setting and remain subject to pairing and TELEGRAM_ALLOWED_IDS.",
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
  wechat: {
    envKey: "WECHAT_BOT_TOKEN",
    description: "WeChat (personal) bot messaging",
    help: "Captured automatically via a host-side QR scan during onboard — pair the bot by scanning the QR with WeChat on your phone (Discover → Scan). DM-only.",
    label: "WeChat Bot Token",
    userIdEnvKey: "WECHAT_ALLOWED_IDS",
    userIdHelp:
      "Optional: restrict who can DM the bot. The WeChat user id of the operator who scanned is added automatically; supply additional ids as a comma-separated list.",
    userIdLabel: "WeChat User ID(s) (DM allowlist)",
    allowIdsMode: "dm",
    loginMethod: "host-qr",
  },
  slack: {
    envKey: "SLACK_BOT_TOKEN",
    description: "Slack bot messaging",
    help: "Slack API → Your Apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...).",
    label: "Slack Bot Token",
    tokenFormat: /^xoxb-[A-Za-z0-9_-]+$/,
    tokenFormatHint: "Slack bot tokens start with 'xoxb-' (e.g. xoxb-1234-5678-abcdef).",
    appTokenEnvKey: "SLACK_APP_TOKEN",
    appTokenHelp: "Slack API → Your Apps → Basic Information → App-Level Tokens (xapp-...).",
    appTokenLabel: "Slack App Token (Socket Mode)",
    appTokenFormat: /^xapp-[A-Za-z0-9_-]+$/,
    appTokenFormatHint: "Slack app tokens start with 'xapp-' (e.g. xapp-1-A0000-12345-abcdef).",
    userIdEnvKey: "SLACK_ALLOWED_USERS",
    userIdHelp:
      "In Slack, open each allowed human user's profile -> More -> Copy member ID. Enter one or more comma-separated member IDs, not the app or bot user ID. Member IDs look like U01ABC2DEF3.",
    userIdLabel: "Slack Member IDs (comma-separated allowlist)",
    allowIdsMode: "dm",
    channelIdEnvKey: "SLACK_ALLOWED_CHANNELS",
    channelIdHelp:
      "Optional: enter comma-separated Slack channel IDs where the bot may answer @mentions. Channel IDs look like C012AB3CD.",
    channelIdLabel: "Slack Channel IDs (comma-separated allowlist)",
  },
  whatsapp: {
    description: "WhatsApp Web messaging (QR pairing)",
    help: "WhatsApp Web pairs via QR code scanned with your phone — no host-side token. After the sandbox is running, connect to it (e.g. `openshell sandbox connect <sandbox>`) and run `openclaw channels login --channel whatsapp` for OpenClaw or `hermes whatsapp` for Hermes. NemoClaw renders the OpenClaw QR in compact (scan-friendly) form and validates the gateway before pairing, so a gateway close (e.g. `1008`) is reported separately from the QR (issue #4522).",
    label: "WhatsApp",
    loginMethod: "in-sandbox-qr",
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
  if (!channel.envKey) return [];
  return channel.appTokenEnvKey ? [channel.envKey, channel.appTokenEnvKey] : [channel.envKey];
}

export function channelUsesInSandboxQrPairing(channel: ChannelDef): boolean {
  return channel.loginMethod === "in-sandbox-qr";
}

export function channelHasStaticToken(
  channel: ChannelDef,
): channel is CredentialBackedChannelDef & { envKey: string } {
  return typeof channel.envKey === "string" && channel.envKey.length > 0;
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
