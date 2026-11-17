// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import type { TokenPasteHookOptions } from "../../../hooks/common/token-paste";
import type { OpenClawBridgeHealthHookOptions } from "../../openclaw-bridge-health";
import { createDiscordOpenClawBridgeHealthHookRegistration } from "./openclaw-bridge-health";
import {
  createDiscordTokenPasteHookRegistration,
  type DiscordAuthenticationHookOptions,
} from "./authentication";
import { createDiscordStatusHealthHookRegistration } from "./status-health";
import type { ChannelStatusHealthHookOptions } from "../../channel-health";

export * from "./openclaw-bridge-health";

export interface DiscordHookOptions {
  readonly authentication?: DiscordAuthenticationHookOptions;
  readonly statusHealth?: ChannelStatusHealthHookOptions;
  readonly openclawBridgeHealth?: OpenClawBridgeHealthHookOptions;
}

export function createDiscordHookRegistrations(
  options: DiscordHookOptions = {},
  tokenPasteOptions: TokenPasteHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [
    createDiscordTokenPasteHookRegistration(options.authentication, tokenPasteOptions),
    createDiscordStatusHealthHookRegistration(options.statusHealth),
    createDiscordOpenClawBridgeHealthHookRegistration(options.openclawBridgeHealth),
  ] as const;
}
