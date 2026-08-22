// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure Telegram-state predicate shared by the channels-add-remove live E2E
// target and its PR-collected unit test. The live probe emits only booleans so
// it does not expose credential-bearing OpenClaw configuration.

export interface OpenClawTelegramState {
  accountEnabled: boolean;
  channelEnabled: boolean;
  channelPresent: boolean;
  pluginEnabled: boolean;
  pluginPresent: boolean;
}

export function openClawHasConfiguredTelegram(state: OpenClawTelegramState): boolean {
  return state.channelEnabled && state.pluginEnabled;
}
