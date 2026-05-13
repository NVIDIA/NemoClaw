// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential } from "../credentials/store";
import type { WebSearchConfig } from "../inference/web-search";
import { isExperimentalChannelGateEnabled } from "./messaging-state";

const { LOCAL_INFERENCE_PROVIDERS } = require("./providers") as {
  LOCAL_INFERENCE_PROVIDERS: string[];
};

export interface SuggestedPolicyPresetOptions {
  enabledChannels?: string[] | null;
  webSearchConfig?: WebSearchConfig | null;
  provider?: string | null;
  isNonInteractive?: () => boolean;
  experimentalEnabled?: boolean;
}

export function getSuggestedPolicyPresets({
  enabledChannels = null,
  webSearchConfig = null,
  provider = null,
  isNonInteractive,
  experimentalEnabled = isExperimentalChannelGateEnabled(),
}: SuggestedPolicyPresetOptions = {}): string[] {
  const suggestions = ["pypi", "npm"];

  if (provider && LOCAL_INFERENCE_PROVIDERS.includes(provider)) {
    suggestions.push("local-inference");
  }
  const usesExplicitMessagingSelection = Array.isArray(enabledChannels);
  const nonInteractive =
    isNonInteractive?.() ?? process.env.NEMOCLAW_NON_INTERACTIVE === "1";

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
  if (experimentalEnabled) {
    maybeSuggestMessagingPreset("whatsapp", null);
  }

  if (webSearchConfig) suggestions.push("brave");

  return suggestions;
}
