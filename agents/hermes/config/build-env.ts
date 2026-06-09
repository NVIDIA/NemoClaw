// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

export type MessagingAllowedIds = Record<string, (string | number)[]>;

export type DiscordGuilds = Record<
  string,
  {
    requireMention?: boolean;
    users?: (string | number)[];
  }
>;

export type TelegramConfig = {
  requireMention?: boolean;
};

// Non-secret per-account metadata captured by the host-side iLink QR login
// during onboard (src/lib/onboard/wechat-config.ts). The bot token itself
// stays in the OpenShell credential store; only these fields are serialized
// into the build arg, so the in-sandbox adapter can hydrate WEIXIN_ACCOUNT_ID
// and WEIXIN_BASE_URL without a fresh QR scan on rebuild.
export type WechatConfig = {
  accountId?: string;
  baseUrl?: string;
  userId?: string;
};

export type SlackConfig = {
  allowedChannels?: string[];
};

export type HermesBuildSettings = {
  model: string;
  baseUrl: string;
  providerKey: string;
  upstreamProvider: string;
  inferenceApi: string;
  managedToolGateways: {
    brokerEnabled: boolean;
    presets: string[];
  };
  messaging: {
    enabledChannels: Set<string>;
    allowedIds: MessagingAllowedIds;
    discordGuilds: DiscordGuilds;
    telegramConfig: TelegramConfig;
    wechatConfig: WechatConfig;
    slackConfig: SlackConfig;
  };
};

export function readHermesBuildSettings(env: NodeJS.ProcessEnv): HermesBuildSettings {
  const model = readRequiredEnv(env, "NEMOCLAW_MODEL");
  const baseUrl = readRequiredEnv(env, "NEMOCLAW_INFERENCE_BASE_URL");

  return {
    model,
    baseUrl,
    providerKey: env.NEMOCLAW_PROVIDER_KEY || "custom",
    upstreamProvider: env.NEMOCLAW_UPSTREAM_PROVIDER || env.NEMOCLAW_PROVIDER_KEY || "custom",
    inferenceApi: env.NEMOCLAW_INFERENCE_API || "",
    managedToolGateways: {
      brokerEnabled: env.NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER === "1",
      presets: readBase64Json<string[]>(
        env,
        "NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64",
        "W10=",
      ),
    },
    messaging: {
      enabledChannels: new Set(
        readBase64Json<string[]>(env, "NEMOCLAW_MESSAGING_CHANNELS_B64", "W10="),
      ),
      allowedIds: readBase64Json<MessagingAllowedIds>(
        env,
        "NEMOCLAW_MESSAGING_ALLOWED_IDS_B64",
        "e30=",
      ),
      discordGuilds: readBase64Json<DiscordGuilds>(env, "NEMOCLAW_DISCORD_GUILDS_B64", "e30="),
      telegramConfig: readBase64Json<TelegramConfig>(
        env,
        "NEMOCLAW_TELEGRAM_CONFIG_B64",
        "e30=",
      ),
      wechatConfig: readBase64Json<WechatConfig>(env, "NEMOCLAW_WECHAT_CONFIG_B64", "e30="),
      slackConfig: readBase64Json<SlackConfig>(env, "NEMOCLAW_SLACK_CONFIG_B64", "e30="),
    },
  };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readBase64Json<T>(env: NodeJS.ProcessEnv, name: string, defaultValue: string): T {
  const encoded = env[name] || defaultValue;
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as T;
}
