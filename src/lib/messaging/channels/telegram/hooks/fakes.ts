// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks";

export const TELEGRAM_GET_ME_REACHABILITY_HOOK_ID = "telegram.getMeReachability";

export const fakeTelegramGetMeReachabilityHook: MessagingHookHandler = (context) => {
  const token = context.inputs?.botToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Telegram reachability check requires botToken.");
  }
  return {};
};

export const FAKE_TELEGRAM_HOOK_REGISTRATIONS: readonly MessagingHookRegistration[] = [
  {
    id: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
    handler: fakeTelegramGetMeReachabilityHook,
  },
] as const;
