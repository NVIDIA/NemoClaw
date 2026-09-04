// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesManagedRouting } from "../../../src/lib/hermes-managed-route.ts";
import { applyHermesManagedRoute } from "../../../src/lib/hermes-managed-route.ts";
import type { HermesBuildSettings } from "./build-env.ts";
import { buildHermesEnvLines } from "./hermes-env.ts";
import {
  applyManagedToolConfig,
  effectiveManagedToolGatewayPresets,
  loadManagedToolGatewayMatrix,
} from "./managed-tool-gateway.ts";
import { isObjectRecord } from "./object-record.ts";

export type { HermesManagedRoute } from "../../../src/lib/hermes-managed-route.ts";
export {
  applyHermesManagedRoute,
  hermesApiMode,
  hermesProviderKey,
} from "../../../src/lib/hermes-managed-route.ts";

export const HERMES_MANAGED_POLICY_SCHEMA_VERSION = 1 as const;

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

export const MANAGED_IMAGE_HERMES_SUPPORTED_PLATFORMS = [
  "telegram",
  "discord",
  "weixin",
  "slack",
  "whatsapp",
  "teams",
  "google_chat",
] as const;

// Hermes v0.20.6 also packages platform plugins and built-in adapters that are
// not yet supported by NemoClaw's messaging manifests. A neutral managed image
// must explicitly disable the complete installed surface, while keeping this
// list separate from the supported/activatable contract above.
export const MANAGED_IMAGE_HERMES_NEUTRAL_PLATFORMS = [
  "a2a",
  "bluebubbles",
  "buzz",
  "dingtalk",
  "discord",
  "email",
  "feishu",
  "google_chat",
  "homeassistant",
  "irc",
  "line",
  "matrix",
  "mattermost",
  "msgraph_webhook",
  "ntfy",
  "photon",
  "qqbot",
  "raft",
  "relay",
  "signal",
  "simplex",
  "slack",
  "sms",
  "teams",
  "telegram",
  "wecom",
  "wecom_callback",
  "weixin",
  "whatsapp",
  "whatsapp_cloud",
  "webhook",
  "yuanbao",
] as const;

const DASHBOARD_ROUTING_KEYS = [
  "model",
  "providers",
  "custom_providers",
  "_nemoclaw_upstream",
] as const;

const DASHBOARD_ENV_KEYS = [
  "API_SERVER_HOST",
  "API_SERVER_PORT",
  "TAVILY_API_KEY",
  "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER",
  "FIRECRAWL_GATEWAY_URL",
  "OPENAI_AUDIO_GATEWAY_URL",
  "BROWSER_USE_GATEWAY_URL",
  "FAL_QUEUE_GATEWAY_URL",
  "MODAL_GATEWAY_URL",
] as const;

const MANAGED_POLICY_PATHS = [
  "approvals.mode",
  "browser.allow_unsafe_evaluate",
  "browser.restrict_evaluate",
  "session_reset.mode",
  "session_reset.at_hour",
  "session_reset.idle_minutes",
  "session_reset.notify",
  "session_reset.notify_exclude_platforms",
  "session_reset.bg_process_max_age_hours",
  "display.show_reasoning",
  "display.show_commentary",
  "updates.pre_update_backup",
  "updates.refresh_cua_driver",
] as const;

type HermesManagedConfigBase = Record<string, unknown> & {
  _config_version: number;
  approvals: { mode: "manual" | "smart" | "off" };
  browser: { allow_unsafe_evaluate: boolean; restrict_evaluate: boolean };
  display: {
    compact: boolean;
    tool_progress: string;
    interim_assistant_messages: boolean;
    show_reasoning: boolean;
    show_commentary: boolean;
  };
  session_reset: {
    mode: "daily" | "idle" | "both" | "none";
    at_hour: number;
    idle_minutes: number;
    notify: boolean;
    notify_exclude_platforms: string[];
    bg_process_max_age_hours: number;
  };
  updates: { pre_update_backup: boolean | string; refresh_cua_driver: boolean };
  tools: {
    tool_search: {
      enabled: "on" | "off";
      search_default_limit: number;
      max_search_limit: number;
    };
  };
};

export type HermesManagedConfig = HermesManagedConfigBase & HermesManagedRouting;

export type HermesManagedPolicyV1 = {
  schema_version: typeof HERMES_MANAGED_POLICY_SCHEMA_VERSION;
  config: HermesManagedConfig;
  env_lines: string[];
  dashboard: {
    routing_keys: [...typeof DASHBOARD_ROUTING_KEYS];
    env_keys: [...typeof DASHBOARD_ENV_KEYS];
  };
  managed_paths: [...typeof MANAGED_POLICY_PATHS];
};

export function buildHermesManagedPolicy(
  settings: HermesBuildSettings,
  env: NodeJS.ProcessEnv = process.env,
): HermesManagedPolicyV1 {
  const platforms: Record<string, unknown> = {
    api_server: {
      enabled: true,
      extra: {
        port: 18642,
        host: "127.0.0.1",
      },
    },
  };
  if (settings.managedImageCapabilityUnion) {
    for (const platform of MANAGED_IMAGE_HERMES_NEUTRAL_PLATFORMS) {
      platforms[platform] = { enabled: false };
    }
  }

  const config: HermesManagedConfigBase = {
    _config_version: 33,
    approvals: {
      // Hermes 0.19 defaults an omitted mode to smart authorization.
      // Automated command authorization needs a separate product decision.
      mode: "manual",
    },
    browser: {
      // Keep unsafe and sensitive browser evaluation restricted for hostile pages.
      allow_unsafe_evaluate: false,
      restrict_evaluate: true,
    },
    session_reset: {
      // Preserve the prior daily and idle expiry instead of inheriting an
      // upstream no-reset default.
      mode: "both",
      at_hour: 4,
      idle_minutes: 1440,
      notify: true,
      notify_exclude_platforms: ["api_server", "webhook"],
      bg_process_max_age_hours: 24,
    },
    terminal: {
      backend: "local",
      timeout: 180,
    },
    agent: {
      max_turns: 60,
      verify_on_stop: false,
    },
    tools: {
      tool_search: {
        // Hermes keeps built-in core tools visible and defers the remaining
        // catalog behind its native tool search.
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
      show_reasoning: false,
      show_commentary: false,
    },
    updates: {
      // NemoClaw owns image updates, so Hermes must not snapshot state or fetch
      // a mutable CUA driver during its own update path.
      pre_update_backup: false,
      refresh_cua_driver: false,
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
      api_server: buildHermesRemotePlatformToolsets(settings),
    },
    platforms,
  };

  applyHermesManagedRoute(config, {
    model: settings.model,
    baseUrl: settings.baseUrl,
    upstreamProvider: settings.upstreamProvider,
    inferenceApi: settings.inferenceApi,
    contextWindow: settings.contextWindow,
  });

  const managedToolGatewayPresets = effectiveManagedToolGatewayPresets(settings);
  if (managedToolGatewayPresets.length > 0) {
    const matrix = loadManagedToolGatewayMatrix(env);
    for (const preset of managedToolGatewayPresets) {
      const entry = matrix[preset];
      if (!entry) throw new Error(`Unknown Hermes managed-tool gateway preset: ${preset}`);
      applyManagedToolConfig(config, entry.config);
    }
  }

  // An explicit Tavily selection replaces managed Firecrawl settings.
  if (settings.webSearchProvider === "tavily") config.web = { backend: "tavily" };

  return {
    schema_version: HERMES_MANAGED_POLICY_SCHEMA_VERSION,
    config,
    env_lines: buildHermesEnvLines(settings, env),
    dashboard: {
      routing_keys: [...DASHBOARD_ROUTING_KEYS],
      env_keys: [...DASHBOARD_ENV_KEYS],
    },
    managed_paths: [...MANAGED_POLICY_PATHS],
  };
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
    settings.managedToolGateways.presets.includes("nous-audio")
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
  return isObjectRecord(value) && value.enabled === true;
}
