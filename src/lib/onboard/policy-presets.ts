// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential } from "../credentials/store";
import type { WebSearchConfig } from "../inference/web-search";

const { LOCAL_INFERENCE_PROVIDERS } = require("./providers") as {
  LOCAL_INFERENCE_PROVIDERS: string[];
};
import { isOpenclawAgent, requiredOpenclawOtelPolicyPresets } from "./openclaw-otel-policy-presets";

export interface SuggestedPolicyPresetOptions {
  enabledChannels?: string[] | null;
  webSearchConfig?: WebSearchConfig | null;
  provider?: string | null;
  agent?: string | null;
  isNonInteractive?: () => boolean;
  env?: NodeJS.ProcessEnv;
}

export function getSuggestedPolicyPresets({
  enabledChannels = null,
  webSearchConfig = null,
  provider = null,
  agent = null,
  isNonInteractive,
  env = process.env,
}: SuggestedPolicyPresetOptions = {}): string[] {
  const suggestions = ["pypi", "npm"];

  if (provider && LOCAL_INFERENCE_PROVIDERS.includes(provider)) {
    suggestions.push("local-inference");
  }
  if (isOpenclawAgent(agent)) {
    suggestions.push("openclaw-pricing");
    suggestions.push(...requiredOpenclawOtelPolicyPresets(agent, env));
  }
  const usesExplicitMessagingSelection = Array.isArray(enabledChannels);
  const nonInteractive = isNonInteractive?.() ?? process.env.NEMOCLAW_NON_INTERACTIVE === "1";

  const maybeSuggestMessagingPreset = (channel: string, envKey: string | null): void => {
    if (usesExplicitMessagingSelection) {
      if (enabledChannels.includes(channel)) suggestions.push(channel);
      return;
    }
    if (envKey === null) return;
    if (getCredential(envKey) || process.env[envKey]) {
      suggestions.push(channel);
      if (process.stdout.isTTY && !nonInteractive && process.env.CI !== "true") {
        console.log(`  Auto-detected: ${envKey} -> suggesting ${channel} preset`);
      }
    }
  };

  maybeSuggestMessagingPreset("telegram", "TELEGRAM_BOT_TOKEN");
  maybeSuggestMessagingPreset("slack", "SLACK_BOT_TOKEN");
  maybeSuggestMessagingPreset("discord", "DISCORD_BOT_TOKEN");
  maybeSuggestMessagingPreset("wechat", "WECHAT_BOT_TOKEN");
  maybeSuggestMessagingPreset("whatsapp", null);

  if (webSearchConfig) suggestions.push("brave");

  return suggestions;
}
