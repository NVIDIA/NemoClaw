// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesBuildSettings } from "./build-env.ts";
import {
  applyManagedToolConfig,
  effectiveManagedToolGatewayPresets,
  loadManagedToolGatewayMatrix,
} from "./managed-tool-gateway.ts";

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

export function buildHermesConfig(
  settings: HermesBuildSettings,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const remotePlatformToolsets = buildHermesRemotePlatformToolsets(settings);
  const modelProviderName = "custom";
  const pickerProviderName = settings.upstreamProvider || "nemoclaw-inference";
  const modelConfig: Record<string, unknown> = {
    default: settings.model,
    provider: modelProviderName,
    base_url: settings.baseUrl,
    api_key: "sk-OPENSHELL-PROXY-REWRITE",
  };
  const apiMode = hermesApiMode(settings.inferenceApi);
  if (apiMode) modelConfig.api_mode = apiMode;
  // context_length on the model block is Hermes' highest-priority context
  // override — above live /v1/models discovery and its built-in model-metadata
  // registry. Setting it stops NemotronH-family models from falling back to a
  // small architecture default when the endpoint actually serves a larger
  // max_model_len (#6177). Omit it (null) to let Hermes auto-detect. Hermes
  // reads only `context_length`; `context_window` is silently ignored.
  //
  // No separate auxiliary/compression context key is written: Hermes derives
  // its compression trigger (compression.threshold × context_length) from the
  // main model's context_length, so setting it here is sufficient for the
  // reported "Cannot compress further" failure — the auxiliary/curator model is
  // configured via auxiliary.* and needs no dedicated context length here.
  if (settings.contextWindow !== null) modelConfig.context_length = settings.contextWindow;

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
  const customProvider: Record<string, unknown> = {
    name: pickerProviderName,
    base_url: settings.baseUrl,
    api_key: "sk-OPENSHELL-PROXY-REWRITE",
    discover_models: true,
  };
  if (apiMode) customProvider.api_mode = apiMode;
  const providerConfig: Record<string, unknown> = {
    name: pickerProviderName,
    api: settings.baseUrl,
    api_key: "sk-OPENSHELL-PROXY-REWRITE",
    default_model: settings.model,
    discover_models: true,
  };
  if (apiMode) providerConfig.transport = apiMode;

  const upstream: Record<string, unknown> = {
    provider: settings.upstreamProvider,
    model: settings.model,
  };

  const config: Record<string, unknown> = {
    _config_version: 30,
    _nemoclaw_upstream: upstream,
    model: modelConfig,
    providers: {
      [pickerProviderName]: providerConfig,
    },
    custom_providers: [customProvider],
    terminal: {
      backend: "local",
      timeout: 180,
    },
    agent: {
      max_turns: 60,
      reasoning_effort: "medium",
    },
    tools: {
      tool_search: {
        // Deliberately defer every MCP and non-core plugin tool, even for a
        // small catalog. Hermes keeps its built-in core tools directly visible.
        // Keep Hermes' native snake_case keys and 5/20 limits distinct from
        // OpenClaw's camelCase Tool Search contract and 8-result default.
        enabled: settings.toolDisclosure === "direct" ? "off" : "on",
        search_default_limit: 5,
        max_search_limit: 20,
      },
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
      interim_assistant_messages: true,
    },
    curator: {
      enabled: true,
      interval_hours: 168,
      min_idle_hours: 2,
      stale_after_days: 30,
      archive_after_days: 90,
      consolidate: false,
      prune_builtins: true,
      backup: {
        enabled: true,
        keep: 5,
      },
    },
    auxiliary: {
      curator: {
        provider: "auto",
        model: "",
        base_url: "",
        api_key: "",
        timeout: 600,
        extra_body: {},
      },
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

  const managedToolGatewayPresets = effectiveManagedToolGatewayPresets(settings);
  if (managedToolGatewayPresets.length > 0) {
    const matrix = loadManagedToolGatewayMatrix(env);
    for (const preset of managedToolGatewayPresets) {
      const entry = matrix[preset];
      if (!entry) {
        throw new Error(`Unknown Hermes managed-tool gateway preset: ${preset}`);
      }
      applyManagedToolConfig(config, entry.config);
    }
  }

  // An explicitly selected Tavily credential takes precedence over the
  // Nous-managed Firecrawl gateway. Replacing the whole section also removes
  // `use_gateway: true`, which would otherwise keep Hermes on Firecrawl.
  if (settings.webSearchProvider === "tavily") {
    config.web = { backend: "tavily" };
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
