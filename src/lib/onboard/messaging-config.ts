// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getMessagingChannelConfigFromPlan } from "../messaging/plan-validation";
import {
  type MessagingChannelConfig,
  mergeMessagingChannelConfigs,
} from "../messaging-channel-config";
import type { Session } from "../state/onboard-session";
import * as registry from "../state/registry";

export function getStoredMessagingChannelConfig(
  sandboxName: string | null,
  session: Session | null,
): MessagingChannelConfig | null {
  const registryConfig = sandboxName
    ? getMessagingChannelConfigFromPlan(
        registry.getMessagingPlanFromEntry(registry.getSandbox(sandboxName)),
      )
    : null;
  const sessionMatchesSandbox =
    !session?.sandboxName || !sandboxName || session.sandboxName === sandboxName;
  const sessionConfig = sessionMatchesSandbox
    ? getMessagingChannelConfigFromPlan(session?.messagingPlan)
    : null;
  const legacySessionConfig = sessionMatchesSandbox
    ? getLegacySessionMessagingChannelConfig(session)
    : null;
  return mergeMessagingChannelConfigs(legacySessionConfig, registryConfig, sessionConfig);
}

export function messagingChannelConfigsEqual(
  left: MessagingChannelConfig | null,
  right: MessagingChannelConfig | null,
): boolean {
  const leftKeys = Object.keys(left || {}).sort();
  const rightKeys = Object.keys(right || {}).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left?.[key] === right?.[key]);
}

function getLegacySessionMessagingChannelConfig(
  session: Session | null,
): MessagingChannelConfig | null {
  const config: MessagingChannelConfig = {};
  if (typeof session?.telegramConfig?.requireMention === "boolean") {
    config.TELEGRAM_REQUIRE_MENTION = session.telegramConfig.requireMention ? "1" : "0";
  }
  if (session?.wechatConfig?.accountId) config.WECHAT_ACCOUNT_ID = session.wechatConfig.accountId;
  if (session?.wechatConfig?.baseUrl) config.WECHAT_BASE_URL = session.wechatConfig.baseUrl;
  if (session?.wechatConfig?.userId) config.WECHAT_USER_ID = session.wechatConfig.userId;
  return Object.keys(config).length > 0 ? config : null;
}
