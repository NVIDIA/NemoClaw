// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesBuildSettings } from "./build-env.ts";
import { buildDiscordConfig } from "./messaging-config.ts";

export function buildHermesConfig(settings: HermesBuildSettings): Record<string, unknown> {
  const config: Record<string, unknown> = {
    _config_version: 12,
    model: {
      default: settings.model,
      provider: "custom",
      base_url: settings.baseUrl,
    },
    terminal: {
      backend: "local",
      timeout: 180,
    },
    agent: {
      max_turns: 60,
      reasoning_effort: "medium",
    },
    memory: {
      memory_enabled: true,
      user_profile_enabled: true,
    },
    skills: {
      creation_nudge_interval: 15,
    },
    display: {
      compact: false,
      tool_progress: "all",
    },
  };

  // Hermes v2026.4.23 reads Discord behavior from top-level `discord:`.
  // Bot tokens and user allowlists stay in .env so config.yaml never carries
  // real secrets or credential placeholders under platforms.discord.
  if (settings.messaging.enabledChannels.has("discord")) {
    config.discord = buildDiscordConfig(settings.messaging.discordGuilds);
  }

  const telegramConfig = settings.messaging.telegramConfig;
  if (
    settings.messaging.enabledChannels.has("telegram") &&
    typeof telegramConfig.requireMention === "boolean"
  ) {
    config.telegram = {
      require_mention: telegramConfig.requireMention,
    };
  }

  // WeChat is DM-only with no mention concept. The non-secret per-account
  // metadata captured by the host-side QR login is surfaced here so the
  // upstream @tencent-weixin/openclaw-weixin plugin (and the wrapper that
  // pre-seeds it) can pick the right IDC base URL without re-running QR
  // login inside the sandbox.
  const wechatConfig = settings.messaging.wechatConfig;
  if (settings.messaging.enabledChannels.has("wechat")) {
    const wechatBlock: Record<string, unknown> = {};
    if (wechatConfig.accountId) wechatBlock.account_id = wechatConfig.accountId;
    if (wechatConfig.baseUrl) wechatBlock.base_url = wechatConfig.baseUrl;
    if (wechatConfig.userId) wechatBlock.user_id = wechatConfig.userId;
    if (Object.keys(wechatBlock).length > 0) {
      config.wechat = wechatBlock;
    }
  }

  // API server — internal port only.
  // Hermes binds to 127.0.0.1 regardless of config (upstream bug).
  // socat in start.sh forwards 0.0.0.0:8642 -> 127.0.0.1:18642.
  config.platforms = {
    api_server: {
      enabled: true,
      extra: {
        port: 18642,
        host: "127.0.0.1",
      },
    },
  };

  return config;
}
