// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesBuildSettings } from "./build-env.ts";
import {
  applyManagedToolConfig,
  loadManagedToolGatewayMatrix,
} from "./managed-tool-gateway.ts";
import { buildDiscordConfig } from "./messaging-config.ts";

const API_SERVER_TOOLSETS = [
  "web",
  "browser",
  "terminal",
  "file",
  "code_execution",
  "vision",
  "image_gen",
  "skills",
  "todo",
  "memory",
  "session_search",
  "delegation",
  "cronjob",
  "nemoclaw",
  "audio",
];

export function buildHermesConfig(settings: HermesBuildSettings): Record<string, unknown> {
  const apiServerToolsets = [...API_SERVER_TOOLSETS];
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
    plugins: {
      enabled: ["nemoclaw"],
    },
    platform_toolsets: {
      api_server: apiServerToolsets,
    },
  };

  // Hermes v2026.4.23 reads Discord behavior from top-level `discord:`.
  // Bot tokens and user allowlists stay in .env so config.yaml never carries
  // real secrets or credential placeholders under platforms.discord.
  if (settings.messaging.enabledChannels.has("discord")) {
    config.discord = buildDiscordConfig(settings.messaging.discordGuilds);
  }

  if (settings.managedToolGateways.brokerEnabled) {
    const matrix = loadManagedToolGatewayMatrix();
    for (const preset of settings.managedToolGateways.presets) {
      const entry = matrix[preset];
      if (!entry) {
        throw new Error(`Unknown Hermes managed-tool gateway preset: ${preset}`);
      }
      applyManagedToolConfig(config, entry.config);
    }
    if (
      settings.managedToolGateways.presets.includes("nous-audio") &&
      !apiServerToolsets.includes("tts")
    ) {
      apiServerToolsets.push("tts");
    }
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
