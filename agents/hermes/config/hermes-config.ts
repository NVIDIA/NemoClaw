// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesBuildSettings } from "./build-env.ts";
import { applyManagedToolConfig, loadManagedToolGatewayMatrix } from "./managed-tool-gateway.ts";

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

function hermesApiMode(inferenceApi: string): string | null {
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
  const remotePlatformToolsets = buildHermesRemotePlatformToolsets(settings);
  const modelConfig: Record<string, unknown> = {
    default: settings.model,
    provider: "custom",
    base_url: settings.baseUrl,
    api_key: "sk-OPENSHELL-PROXY-REWRITE",
  };
  const apiMode = hermesApiMode(settings.inferenceApi);
  if (apiMode) modelConfig.api_mode = apiMode;

  // Surface the managed endpoint to Hermes' model picker. The inline `model:`
  // block above is enough for the gateway to ROUTE inference, but the picker
  // (CLI `hermes model` and the dashboard Models page via /api/model/options)
  // enumerates providers through get_compatible_custom_providers(), which only
  // reads `custom_providers:` / `providers:` — never the inline `model:` block.
  // Without an entry here the picker shows zero models even though inference
  // works. Mirror the same proxied endpoint and let Hermes live-discover the
  // available models from /v1/models (served by the OpenShell inference proxy;
  // GET /v1/models is allowlisted in policy-additions.yaml). discover_models is
  // Hermes' default, but we set it explicitly so the intent survives upstream
  // default changes, and we omit an explicit `models:` list precisely so the
  // picker reflects the live catalog rather than a single hard-coded id.
  const providerName = settings.upstreamProvider || "nemoclaw-inference";
  const customProvider: Record<string, unknown> = {
    name: providerName,
    base_url: settings.baseUrl,
    api_key: "sk-OPENSHELL-PROXY-REWRITE",
    discover_models: true,
  };
  if (apiMode) customProvider.api_mode = apiMode;

  const upstream: Record<string, unknown> = {
    provider: settings.upstreamProvider,
    model: settings.model,
  };

  const config: Record<string, unknown> = {
    _config_version: 12,
    _nemoclaw_upstream: upstream,
    model: modelConfig,
    custom_providers: [customProvider],
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
    platforms: {
      api_server: {
        enabled: true,
        extra: {
          port: 18642,
          host: "127.0.0.1",
        },
      },
    },
  };

  if (settings.managedToolGateways.brokerEnabled) {
    const matrix = loadManagedToolGatewayMatrix();
    for (const preset of settings.managedToolGateways.presets) {
      const entry = matrix[preset];
      if (!entry) {
        throw new Error(`Unknown Hermes managed-tool gateway preset: ${preset}`);
      }
      applyManagedToolConfig(config, entry.config);
    }
  }

  return config;
}

export function finalizeHermesPlatformToolsets(
  config: Record<string, unknown>,
  settings: HermesBuildSettings,
): void {
  addEnabledPlatformToolsets(config, buildHermesRemotePlatformToolsets(settings));
}

function buildHermesRemotePlatformToolsets(settings: HermesBuildSettings): string[] {
  const remotePlatformToolsets = [...REMOTE_PLATFORM_TOOLSETS];
  if (
    settings.managedToolGateways.brokerEnabled &&
    settings.managedToolGateways.presets.includes("nous-audio") &&
    !remotePlatformToolsets.includes("tts")
  ) {
    remotePlatformToolsets.push("tts");
  }
  return remotePlatformToolsets;
}

function addEnabledPlatformToolsets(
  config: Record<string, unknown>,
  remotePlatformToolsets: readonly string[],
): void {
  const platformToolsets = config.platform_toolsets as Record<string, string[]>;
  const platforms = config.platforms as Record<string, unknown>;
  for (const [platform, platformConfig] of Object.entries(platforms)) {
    if (platform === "api_server" || !isEnabledPlatform(platformConfig)) continue;
    platformToolsets[platform] = [...remotePlatformToolsets];
  }
}

function isEnabledPlatform(value: unknown): boolean {
  return isObject(value) && value.enabled === true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
