// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getMessagingChannelConfigFromPlan } from "../messaging/plan-validation";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import {
  type RegistryMessagingAuthority,
  resolveMessagingPlanAuthority,
} from "../messaging/plan-authority";
import type { MessagingChannelConfig } from "../messaging-channel-config";
import type { Session } from "../state/onboard-session";
import {
  getRegistrySandboxMessagingAuthority,
  readMessagingPlanFromEnv,
} from "./messaging-channel-setup";

export { getMessagingChannelConfigFromPlan } from "../messaging/plan-validation";

type StoredMessagingChannelConfigDeps = {
  readMessagingPlanFromEnv(): SandboxMessagingPlan | null;
  getRegistryMessagingAuthority(sandboxName: string): RegistryMessagingAuthority;
};

const defaultDeps: StoredMessagingChannelConfigDeps = {
  readMessagingPlanFromEnv,
  getRegistryMessagingAuthority: getRegistrySandboxMessagingAuthority,
};

export function getStoredMessagingChannelConfig(
  sandboxName: string | null,
  session: Session | null,
  deps: StoredMessagingChannelConfigDeps = defaultDeps,
): MessagingChannelConfig | null {
  const sessionSandboxName = session?.sandboxName ?? session?.messagingPlan?.sandboxName ?? null;
  const initialSandboxName = sandboxName ?? sessionSandboxName;
  let resolvedSandboxName = initialSandboxName;
  let registryAuthority: RegistryMessagingAuthority = initialSandboxName
    ? deps.getRegistryMessagingAuthority(initialSandboxName)
    : { authoritative: false, plan: null };
  let stagedPlan: SandboxMessagingPlan | null = null;
  if (sandboxName === null || !registryAuthority.authoritative) {
    try {
      stagedPlan = deps.readMessagingPlanFromEnv();
    } catch (error) {
      if (!registryAuthority.authoritative) throw error;
    }
    resolvedSandboxName = sandboxName ?? stagedPlan?.sandboxName ?? sessionSandboxName;
    if (resolvedSandboxName && resolvedSandboxName !== initialSandboxName) {
      registryAuthority = deps.getRegistryMessagingAuthority(resolvedSandboxName);
    }
  }
  const sessionMatchesSandbox =
    !session?.sandboxName || !resolvedSandboxName || session.sandboxName === resolvedSandboxName;
  const authority = resolvedSandboxName
    ? resolveMessagingPlanAuthority({
        sandboxName: resolvedSandboxName,
        registry: registryAuthority,
        stagedPlan,
        sessionPlan: sessionMatchesSandbox ? (session?.messagingPlan ?? null) : null,
      })
    : { source: "none" as const, plan: null };
  const selectedConfig = getMessagingChannelConfigFromPlan(authority.plan);
  const legacySessionConfig =
    sessionMatchesSandbox && authority.source === "none"
      ? getLegacySessionMessagingChannelConfig(session)
      : null;
  return selectedConfig ?? legacySessionConfig;
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
