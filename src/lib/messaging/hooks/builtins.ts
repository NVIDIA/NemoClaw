// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createTelegramHookRegistrations,
  type TelegramGetMeReachabilityHookOptions,
} from "../channels/telegram/hooks";
import { createWechatHookRegistrations, type WechatHookOptions } from "../channels/wechat/hooks";
import { createCommonHookRegistrations, type TokenPasteHookOptions } from "./common";
import { MessagingHookRegistry } from "./registry";
import type { MessagingHookRegistration } from "./types";

export interface BuiltInMessagingHookOptions {
  readonly common?: TokenPasteHookOptions;
  readonly telegram?: TelegramGetMeReachabilityHookOptions;
  readonly wechat?: WechatHookOptions;
}

export function createBuiltInMessagingHookRegistrations(
  options: BuiltInMessagingHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [
    ...createCommonHookRegistrations(options.common),
    ...createTelegramHookRegistrations(options.telegram),
    ...createWechatHookRegistrations(options.wechat),
  ];
}

export function createBuiltInMessagingHookRegistry(
  options: BuiltInMessagingHookOptions = {},
): MessagingHookRegistry {
  return new MessagingHookRegistry(createBuiltInMessagingHookRegistrations(options));
}
