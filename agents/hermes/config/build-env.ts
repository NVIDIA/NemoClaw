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

export type HermesBuildSettings = {
  model: string;
  baseUrl: string;
  providerKey: string;
  inferenceApi: string;
  messaging: {
    enabledChannels: Set<string>;
    allowedIds: MessagingAllowedIds;
    discordGuilds: DiscordGuilds;
    telegramConfig: TelegramConfig;
  };
};

export function readHermesBuildSettings(env: NodeJS.ProcessEnv): HermesBuildSettings {
  const model = readRequiredEnv(env, "NEMOCLAW_MODEL");
  const baseUrl = readRequiredEnv(env, "NEMOCLAW_INFERENCE_BASE_URL");

  return {
    model,
    baseUrl,
    providerKey: env.NEMOCLAW_PROVIDER_KEY || "custom",
    inferenceApi: env.NEMOCLAW_INFERENCE_API || "",
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
