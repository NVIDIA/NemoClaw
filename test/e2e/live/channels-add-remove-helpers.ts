// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure Telegram-state predicate shared by the channels-add-remove live E2E
// target and its PR-collected unit test. The live probe emits only booleans so
// it does not expose credential-bearing OpenClaw configuration.

export interface OpenClawTelegramState {
  accountPresent: boolean;
  accountEnabled: boolean;
  channelEnabled: boolean;
  channelPresent: boolean;
  credentialPresent: boolean;
  pluginEnabled: boolean;
  pluginPresent: boolean;
  gatewayCredentialReady?: boolean;
  runtimeCredentialState?: "missing" | "revision-scoped" | "unexpected";
}

export function openClawHasConfiguredTelegram(state: OpenClawTelegramState): boolean {
  return (
    state.accountPresent ||
    state.accountEnabled ||
    state.channelEnabled ||
    state.credentialPresent ||
    state.pluginEnabled
  );
}

export function telegramArtifactContainsCredential(content: string, token: string): boolean {
  // Match complete credential references, not the regex source retained in probe arguments.
  return (
    content.includes(token) ||
    /(?:openshell:resolve:env:|OPENSHELL-RESOLVE-ENV-)(?:(?:v[0-9]+|s[a-f0-9]{64})_)?[A-Z][A-Z0-9_]*/u.test(
      content,
    )
  );
}
