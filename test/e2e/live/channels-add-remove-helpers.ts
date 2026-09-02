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
}

export const TELEGRAM_REVISION_PLACEHOLDER_PATTERN_SOURCE =
  "^openshell:resolve:env:v[0-9]+_TELEGRAM_BOT_TOKEN$";

export function telegramRuntimeCredentialState(
  value: string,
): "missing" | "revision-scoped" | "unexpected" {
  if (!value) return "missing";
  return new RegExp(TELEGRAM_REVISION_PLACEHOLDER_PATTERN_SOURCE, "u").test(value)
    ? "revision-scoped"
    : "unexpected";
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
