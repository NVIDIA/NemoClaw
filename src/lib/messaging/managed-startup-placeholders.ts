// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  authorizeTeamsOpenClawWebhookField,
  type TeamsManagedStartupFieldAuthorization,
} from "./channels/teams/contract.ts";
import {
  authorizeWechatAccountFilePlaceholders,
  WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT,
  type WechatManagedStartupPlaceholderAuthorization,
} from "./channels/wechat/contract.ts";

export type MessagingManagedStartupFieldAuthorization =
  | WechatManagedStartupPlaceholderAuthorization
  | TeamsManagedStartupFieldAuthorization;

export function authorizeMessagingManagedStartupFields(
  entry: unknown,
  section: "buildSteps" | "agentRender",
): readonly MessagingManagedStartupFieldAuthorization[] {
  if (section === "agentRender") return authorizeTeamsOpenClawWebhookField(entry);
  if (!isPlainDataObject(entry)) return [];
  const contract = WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT;
  if (
    ownDataPropertyValue(entry, "channelId") !== contract.channelId ||
    ownDataPropertyValue(entry, "hookId") !== contract.planHookId ||
    ownDataPropertyValue(entry, "handler") !== contract.handlerId ||
    ownDataPropertyValue(entry, "outputId") !== contract.outputId ||
    ownDataPropertyValue(entry, "kind") !== contract.kind ||
    ownDataPropertyValue(entry, "required") !== contract.required
  ) {
    return [];
  }

  return authorizeWechatAccountFilePlaceholders(ownDataPropertyValue(entry, "value")).map(
    (authorization) => ({
      ...authorization,
      path: ["value", ...authorization.path],
    }),
  );
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataPropertyValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
