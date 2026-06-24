// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createDiscordHookRegistrations, type DiscordHookOptions } from "../channels/discord/hooks";
import type { OpenClawBridgeHealthHookOptions } from "../channels/openclaw-bridge-health";
import { createSlackHookRegistrations, type SlackHookOptions } from "../channels/slack/hooks";
import {
  createTelegramHookRegistrations,
  type TelegramHookOptions,
} from "../channels/telegram/hooks";
import { createWechatHookRegistrations, type WechatHookOptions } from "../channels/wechat/hooks";
import { type CommonHookOptions, createCommonHookRegistrations } from "./common";
import { MessagingHookRegistry } from "./registry";
import type { MessagingHookRegistration } from "./types";

export interface BuiltInMessagingHookOptions {
  readonly common?: CommonHookOptions;
  readonly discord?: DiscordHookOptions;
  readonly openclawBridgeHealth?: OpenClawBridgeHealthHookOptions;
  readonly slack?: SlackHookOptions;
  readonly telegram?: TelegramHookOptions;
  readonly wechat?: WechatHookOptions;
}

export function createBuiltInMessagingHookRegistrations(
  options: BuiltInMessagingHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [
    ...createCommonHookRegistrations(options.common),
    ...createDiscordHookRegistrations(
      withOpenClawBridgeHealthOptions(options.discord, options.openclawBridgeHealth),
    ),
    ...createSlackHookRegistrations(
      withOpenClawBridgeHealthOptions(options.slack, options.openclawBridgeHealth),
    ),
    ...createTelegramHookRegistrations(
      withOpenClawBridgeHealthOptions(options.telegram, options.openclawBridgeHealth),
    ),
    ...createWechatHookRegistrations(options.wechat),
  ];
}

export function createBuiltInMessagingHookRegistry(
  options: BuiltInMessagingHookOptions = {},
): MessagingHookRegistry {
  return new MessagingHookRegistry(createBuiltInMessagingHookRegistrations(options));
}

export const BUILT_IN_MESSAGING_HOOK_REGISTRY = createBuiltInMessagingHookRegistry();

function withOpenClawBridgeHealthOptions<
  T extends { readonly openclawBridgeHealth?: OpenClawBridgeHealthHookOptions },
>(options: T | undefined, openclawBridgeHealth: OpenClawBridgeHealthHookOptions | undefined): T {
  return {
    ...options,
    openclawBridgeHealth: {
      ...openclawBridgeHealth,
      ...options?.openclawBridgeHealth,
    },
  } as T;
}
