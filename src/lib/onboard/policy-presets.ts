// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential } from "../credentials/store";
import type { WebSearchConfig } from "../inference/web-search";
import {
  listMessagingCredentialMetadata,
  listMessagingPolicyPresetMetadata,
} from "../messaging/channels";

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

  const credentialsByChannel = new Map<string, string[]>();
  for (const credential of listMessagingCredentialMetadata()) {
    const envKeys = credentialsByChannel.get(credential.channelId) ?? [];
    envKeys.push(credential.providerEnvKey);
    credentialsByChannel.set(credential.channelId, envKeys);
  }

  const maybeSuggestMessagingPreset = (
    channel: string,
    preset: string,
    envKeys: readonly string[],
  ): void => {
    if (usesExplicitMessagingSelection) {
      if (enabledChannels.includes(channel)) suggestions.push(preset);
      return;
    }
    for (const envKey of envKeys) {
      if (getCredential(envKey) || env[envKey]) {
        if (!suggestions.includes(preset)) suggestions.push(preset);
        if (process.stdout.isTTY && !nonInteractive && process.env.CI !== "true") {
          console.log(`  Auto-detected: ${envKey} -> suggesting ${preset} preset`);
        }
        return;
      }
    }
  };

  for (const preset of listMessagingPolicyPresetMetadata()) {
    maybeSuggestMessagingPreset(
      preset.channelId,
      preset.presetName,
      credentialsByChannel.get(preset.channelId) ?? [],
    );
  }

  if (webSearchConfig) suggestions.push("brave");

  return suggestions;
}
