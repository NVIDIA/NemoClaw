// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readMessagingChannelConfigFromEnv } from "../messaging-channel-config";
import * as onboardSession from "../state/onboard-session";
import type { Session } from "../state/onboard-session";
import { computeTelegramRequireMention } from "./messaging-config";
import {
  gatherWechatConfig,
  toSessionWechatConfig,
  type WechatConfigSnapshot,
} from "./wechat-config";

type TelegramConfig = { requireMention?: boolean };

export type SandboxBuildPatchConfig = {
  telegramConfig: TelegramConfig;
  wechatConfig: WechatConfigSnapshot;
};

export type SandboxBuildPatchConfigDeps = {
  readMessagingChannelConfigFromEnv?(env?: NodeJS.ProcessEnv): unknown;
  computeTelegramRequireMention?(): boolean | null;
  loadSession?(): Session | null;
  gatherWechatConfig?(session: Session | null): WechatConfigSnapshot;
  toSessionWechatConfig?(
    cfg: WechatConfigSnapshot,
  ): { accountId?: string; baseUrl?: string; userId?: string } | null;
  updateSession?(mutator: (session: Session) => Session | void): Session;
};

export type PrepareSandboxBuildPatchConfigInput = {
  configuredMessagingChannels?: readonly string[];
  env?: NodeJS.ProcessEnv;
  deps?: SandboxBuildPatchConfigDeps;
};

export function prepareSandboxBuildPatchConfig({
  configuredMessagingChannels,
  env = process.env,
  deps = {},
}: PrepareSandboxBuildPatchConfigInput): SandboxBuildPatchConfig {
  // Dockerfile messaging rendering is sourced from the manifest plan. Reading
  // env config here validates operator-provided channel config before build.
  (deps.readMessagingChannelConfigFromEnv ?? readMessagingChannelConfigFromEnv)(env);
  const configuredChannelNames = new Set(configuredMessagingChannels);

  const telegramConfig: TelegramConfig = {};
  if (configuredChannelNames.has("telegram")) {
    const telegramRequireMention = (
      deps.computeTelegramRequireMention ?? computeTelegramRequireMention
    )();
    if (telegramRequireMention !== null) {
      telegramConfig.requireMention = telegramRequireMention;
    }
  }

  const loadSession = deps.loadSession ?? onboardSession.loadSession;
  const wechatConfig = (deps.gatherWechatConfig ?? gatherWechatConfig)(loadSession());
  (deps.updateSession ?? onboardSession.updateSession)((current) => {
    current.telegramConfig =
      typeof telegramConfig.requireMention === "boolean"
        ? { requireMention: telegramConfig.requireMention }
        : null;
    current.wechatConfig = (deps.toSessionWechatConfig ?? toSessionWechatConfig)(wechatConfig);
    return current;
  });

  return {
    telegramConfig,
    wechatConfig,
  };
}
