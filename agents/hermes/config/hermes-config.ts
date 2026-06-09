// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesBuildSettings } from "./build-env.ts";
import {
  applyManagedToolConfig,
  loadManagedToolGatewayMatrix,
} from "./managed-tool-gateway.ts";
import { buildDiscordConfig } from "./messaging-config.ts";

const REMOTE_PLATFORM_TOOLSETS = [
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

const MESSAGING_PLATFORM_BY_CHANNEL: Record<string, string> = {
  discord: "discord",
  slack: "slack",
  telegram: "telegram",
  wechat: "weixin",
  whatsapp: "whatsapp",
};

function hermesApiMode(inferenceApi: string): string | null {
  // Source of truth: the host-side inference selector and Dockerfile patcher
  // only write the closed set below into NEMOCLAW_INFERENCE_API. Fail fast for
  // any other non-empty value so host/sandbox routing contract drift does not
  // silently fall back to Hermes' default OpenAI-compatible mode.
  switch (inferenceApi) {
    case "":
    case "openai-completions":
      return null;
    case "anthropic-messages":
      return "anthropic_messages";
    case "openai-responses":
      return "codex_responses";
    default:
      throw new Error(`Unsupported Hermes inference API: ${inferenceApi}`);
  }
}

export function buildHermesConfig(settings: HermesBuildSettings): Record<string, unknown> {
  const remotePlatformToolsets = [...REMOTE_PLATFORM_TOOLSETS];
  const modelConfig: Record<string, unknown> = {
    default: settings.model,
    provider: "custom",
    base_url: settings.baseUrl,
    api_key: "sk-OPENSHELL-PROXY-REWRITE",
  };
  const apiMode = hermesApiMode(settings.inferenceApi);
  if (apiMode) modelConfig.api_mode = apiMode;

  const upstream: Record<string, unknown> = {
    provider: settings.upstreamProvider,
    model: settings.model,
  };

  const config: Record<string, unknown> = {
    _config_version: 12,
    _nemoclaw_upstream: upstream,
    model: modelConfig,
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
      api_server: remotePlatformToolsets,
    },
  };

  // Hermes v2026.4.23+ reads Discord behavior from top-level `discord:`.
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
      !remotePlatformToolsets.includes("tts")
    ) {
      remotePlatformToolsets.push("tts");
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
  const platforms: Record<string, unknown> = {
    api_server: {
      enabled: true,
      extra: {
        port: 18642,
        host: "127.0.0.1",
      },
    },
  };

  if (settings.messaging.enabledChannels.has("slack")) {
    platforms.slack = { enabled: true };
  }

  config.platforms = platforms;
  const platformToolsets = config.platform_toolsets as Record<string, string[]>;
  for (const channel of settings.messaging.enabledChannels) {
    const platform = MESSAGING_PLATFORM_BY_CHANNEL[channel];
    if (platform) {
      platformToolsets[platform] = [...remotePlatformToolsets];
    }
  }

  return config;
}
