// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  authorizeWechatManagedStartupPlaceholders,
  type WechatManagedStartupPlaceholderAuthorization,
} from "./channels/wechat/hooks/seed-openclaw-account";

export type MessagingManagedStartupPlaceholderAuthorization =
  WechatManagedStartupPlaceholderAuthorization;

const BUILD_STEP_AUTHORIZERS = [authorizeWechatManagedStartupPlaceholders] as const;

export function authorizeMessagingManagedStartupPlaceholders(
  step: unknown,
): readonly MessagingManagedStartupPlaceholderAuthorization[] {
  for (const authorize of BUILD_STEP_AUTHORIZERS) {
    const authorizations = authorize(step);
    if (authorizations.length > 0) return authorizations;
  }
  return [];
}
