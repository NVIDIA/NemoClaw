// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";

export const WECHAT_HEALTH_CHECK_HOOK_ID = "wechat.healthCheck";

export function createWechatHealthCheckHook(): MessagingHookHandler {
  return (context) => {
    const accountId = context.inputs?.["wechatConfig.accountId"];
    if (typeof accountId !== "string" || accountId.trim().length === 0) {
      throw new Error("WeChat health check requires wechatConfig.accountId.");
    }
    return {};
  };
}

export function createWechatHealthCheckHookRegistration(): MessagingHookRegistration {
  return {
    id: WECHAT_HEALTH_CHECK_HOOK_ID,
    handler: createWechatHealthCheckHook(),
  };
}
