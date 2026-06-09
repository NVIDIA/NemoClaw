// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createSlackHookRegistrations, type SlackHookOptions } from "../channels/slack/hooks";
import {
  createTelegramHookRegistrations,
  type TelegramGetMeReachabilityHookOptions,
} from "../channels/telegram/hooks";
import { createWechatHookRegistrations, type WechatHookOptions } from "../channels/wechat/hooks";
import { createCommonHookRegistrations, type CommonHookOptions } from "./common";
import { MessagingHookRegistry } from "./registry";
import type { MessagingHookRegistration } from "./types";

export interface BuiltInMessagingHookOptions {
  readonly common?: CommonHookOptions;
  readonly slack?: SlackHookOptions;
  readonly telegram?: TelegramGetMeReachabilityHookOptions;
  readonly wechat?: WechatHookOptions;
}

export function createBuiltInMessagingHookRegistrations(
  options: BuiltInMessagingHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [
    ...createCommonHookRegistrations(options.common),
    ...createSlackHookRegistrations(options.slack),
    ...createTelegramHookRegistrations(options.telegram),
    ...createWechatHookRegistrations(options.wechat),
  ];
}

export function createBuiltInMessagingHookRegistry(
  options: BuiltInMessagingHookOptions = {},
): MessagingHookRegistry {
  return new MessagingHookRegistry(createBuiltInMessagingHookRegistrations(options));
}

export const BUILT_IN_MESSAGING_HOOK_REGISTRY = createBuiltInMessagingHookRegistry();
