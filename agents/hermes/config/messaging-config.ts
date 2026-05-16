// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DiscordGuilds, MessagingAllowedIds, WechatConfig } from "./build-env.ts";

// Maps each Hermes-supported channel to the in-sandbox env-var name(s) the
// adapter reads. The values are the names Hermes expects — not the names
// NemoClaw's host-side capture uses. For WeChat, Hermes' upstream docs
// (https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin)
// require WEIXIN_TOKEN, while NemoClaw's OpenShell credential store keys the
// secret under WECHAT_BOT_TOKEN (shared with OpenClaw's bridge). The
// placeholder pattern in buildTokenPlaceholder rewrites at L7 egress, so
// Hermes can read WEIXIN_TOKEN without the host secret rename.
const CHANNEL_TOKEN_ENVS: Record<string, string[]> = {
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  wechat: ["WEIXIN_TOKEN"],
};

export function buildMessagingEnvLines(
  enabledChannels: Set<string>,
  allowedIds: MessagingAllowedIds,
  discordGuilds: DiscordGuilds,
  wechatConfig: WechatConfig,
): string[] {
  const envLines = ["API_SERVER_PORT=18642", "API_SERVER_HOST=127.0.0.1"];

  for (const channel of enabledChannels) {
    const envKeys = CHANNEL_TOKEN_ENVS[channel] ?? [];
    for (const envKey of envKeys) {
      envLines.push(`${envKey}=${buildTokenPlaceholder(channel, envKey)}`);
    }
    if (channel === "discord") {
      const guildIds = Object.keys(discordGuilds).filter(Boolean);
      if (guildIds.length > 0) {
        envLines.push(`NEMOCLAW_DISCORD_GUILD_IDS=${guildIds.join(",")}`);
      }
    }
    if (channel === "wechat") {
      envLines.push(...buildWechatEnvLines(allowedIds, wechatConfig));
    }
  }

  const discordAllowedUsers = collectDiscordAllowedUsers(allowedIds, discordGuilds);
  if (discordAllowedUsers.length > 0) {
    envLines.push(`DISCORD_ALLOWED_USERS=${discordAllowedUsers.join(",")}`);
  } else if (
    enabledChannels.has("discord") &&
    Object.keys(discordGuilds).filter((guildId) => guildId.trim()).length > 0
  ) {
    envLines.push("DISCORD_ALLOW_ALL_USERS=true");
  }
  if (allowedIds.telegram?.length) {
    envLines.push(`TELEGRAM_ALLOWED_USERS=${allowedIds.telegram.map(String).join(",")}`);
  }
  if (allowedIds.slack?.length) {
    envLines.push(`SLACK_ALLOWED_USERS=${allowedIds.slack.map(String).join(",")}`);
  }

  return envLines;
}

function buildTokenPlaceholder(channel: string, envKey: string): string {
  if (channel === "slack" && envKey === "SLACK_BOT_TOKEN") {
    return "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN";
  }
  if (channel === "slack" && envKey === "SLACK_APP_TOKEN") {
    return "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN";
  }
  // Hermes' WeChat adapter reads WEIXIN_TOKEN, but the OpenShell L7 proxy
  // keys the credential by WECHAT_BOT_TOKEN (same slot OpenClaw uses), so
  // the placeholder must reference the host-side credential name.
  if (channel === "wechat" && envKey === "WEIXIN_TOKEN") {
    return "openshell:resolve:env:WECHAT_BOT_TOKEN";
  }
  return `openshell:resolve:env:${envKey}`;
}

// Hermes WeChat adapter env contract per
// https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin —
// WEIXIN_ACCOUNT_ID + WEIXIN_TOKEN are required; the remaining fields are
// optional and only emitted when set. Defaults match the upstream docs
// (WEIXIN_DM_POLICY=open, WEIXIN_GROUP_POLICY=disabled) so we leave them
// off when the operator hasn't customized them — Hermes applies the same
// defaults internally.
function buildWechatEnvLines(
  allowedIds: MessagingAllowedIds,
  wechatConfig: WechatConfig,
): string[] {
  const lines: string[] = [];
  const accountId =
    typeof wechatConfig.accountId === "string" ? wechatConfig.accountId.trim() : "";
  if (!accountId) {
    throw new Error("wechat is enabled but wechatConfig.accountId is missing");
  }
  lines.push(`WEIXIN_ACCOUNT_ID=${accountId}`);
  if (wechatConfig.baseUrl) {
    lines.push(`WEIXIN_BASE_URL=${wechatConfig.baseUrl}`);
  }
  const wechatAllowed = (allowedIds.wechat ?? []).map(String).filter(Boolean);
  // The operator's own WeChat user id (captured at QR login) is added to
  // the allowlist so the bot can DM back the user who paired it without an
  // extra prompt. The host-side handler already pushes this into
  // allowedIds.wechat via defaultUserId, but include wechatConfig.userId
  // defensively in case the channel was added pre-allowlist.
  if (wechatConfig.userId && !wechatAllowed.includes(wechatConfig.userId)) {
    wechatAllowed.unshift(wechatConfig.userId);
  }
  if (wechatAllowed.length > 0) {
    lines.push(`WEIXIN_ALLOWED_USERS=${wechatAllowed.join(",")}`);
  }
  return lines;
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
