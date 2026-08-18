// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  authorizeWechatAccountFilePlaceholders,
  WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT,
  type WechatManagedStartupPlaceholderAuthorization,
} from "./channels/wechat/contract.ts";

export type MessagingManagedStartupPlaceholderAuthorization =
  WechatManagedStartupPlaceholderAuthorization;

export function authorizeMessagingManagedStartupPlaceholders(
  step: unknown,
): readonly MessagingManagedStartupPlaceholderAuthorization[] {
  if (!isPlainDataObject(step)) return [];
  const contract = WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT;
  if (
    ownDataPropertyValue(step, "channelId") !== contract.channelId ||
    ownDataPropertyValue(step, "hookId") !== contract.planHookId ||
    ownDataPropertyValue(step, "handler") !== contract.handlerId ||
    ownDataPropertyValue(step, "outputId") !== contract.outputId ||
    ownDataPropertyValue(step, "kind") !== contract.kind ||
    ownDataPropertyValue(step, "required") !== contract.required
  ) {
    return [];
  }

  return authorizeWechatAccountFilePlaceholders(ownDataPropertyValue(step, "value")).map(
    (authorization) => ({
      ...authorization,
      path: ["value", ...authorization.path],
    }),
  );
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
  );
}

function ownDataPropertyValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
