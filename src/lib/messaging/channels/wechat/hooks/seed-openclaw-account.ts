// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookInputMap,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../../../hooks/types";
import { normalizeWechatIlinkBaseUrl } from "../ilink-base-url";

export const WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID = "wechat.seedOpenClawAccount";
export const WECHAT_TOKEN_PLACEHOLDER = "openshell:resolve:env:WECHAT_BOT_TOKEN";
export const WECHAT_PLUGIN_ID = "openclaw-weixin";
export const WECHAT_PLUGIN_INSTALL_PATH = "/sandbox/.openclaw/extensions/openclaw-weixin";
export const WECHAT_PLUGIN_SPEC = "@tencent-weixin/openclaw-weixin@2.4.3";
export const WECHAT_PLUGIN_INSTALL_SPEC = `npm:${WECHAT_PLUGIN_SPEC}`;

export interface WechatSeedOpenClawAccountHookOptions {
  readonly now?: () => Date | string;
  readonly pluginInstallPath?: string;
  readonly pluginSpec?: string;
}

export function createWechatSeedOpenClawAccountHook(
  options: WechatSeedOpenClawAccountHookOptions = {},
): MessagingHookHandler {
  return (context) => ({
    outputs: buildWechatSeedOpenClawAccountOutputs(context.inputs, options),
  });
}

export function createWechatSeedOpenClawAccountHookRegistration(
  options: WechatSeedOpenClawAccountHookOptions = {},
): MessagingHookRegistration {
  return {
    id: WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
    handler: createWechatSeedOpenClawAccountHook(options),
  };
}

export function buildWechatSeedOpenClawAccountOutputs(
  inputs: MessagingHookInputMap | undefined,
  options: WechatSeedOpenClawAccountHookOptions = {},
): MessagingHookOutputMap {
  const accountId = requiredInputString(inputs, "wechatConfig.accountId");
  assertSafeWechatAccountId(accountId);
  const baseUrl = normalizeWechatIlinkBaseUrl(optionalInputString(inputs, "wechatConfig.baseUrl"));
  const userId = optionalInputString(inputs, "wechatConfig.userId");
  const token =
    optionalInputString(inputs, "credential.wechatBotToken.placeholder") ||
    WECHAT_TOKEN_PLACEHOLDER;
  const savedAt = isoTimestamp(options.now);
  const pluginInstallPath = options.pluginInstallPath ?? WECHAT_PLUGIN_INSTALL_PATH;
  const pluginSpec = options.pluginSpec ?? WECHAT_PLUGIN_SPEC;

  return {
    openclawWeixinAccountsIndex: {
      kind: "build-file",
      value: {
        path: "openclaw-weixin/accounts.json",
        mode: "0600",
        content: [accountId],
      },
    },
    openclawWeixinAccountFile: {
      kind: "build-file",
      value: {
        path: `openclaw-weixin/accounts/${accountId}.json`,
        mode: "0600",
        content: {
          token,
          savedAt,
          ...(baseUrl ? { baseUrl } : {}),
          ...(userId ? { userId } : {}),
        },
      },
    },
    openclawConfigPatch: {
      kind: "build-file",
      value: {
        path: "openclaw.json",
        merge: {
          plugins: {
            installs: {
              [WECHAT_PLUGIN_ID]: {
                source: "npm",
                spec: pluginSpec,
                installPath: pluginInstallPath,
              },
            },
            entries: {
              [WECHAT_PLUGIN_ID]: {
                enabled: true,
              },
            },
          },
          channels: {
            [WECHAT_PLUGIN_ID]: {
              channelConfigUpdatedAt: savedAt,
              accounts: {
                [accountId]: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    },
  };
}

function assertSafeWechatAccountId(accountId: string): void {
  if (
    accountId === "." ||
    accountId === ".." ||
    /[\\/\0-\x1F\x7F]/.test(accountId) ||
    accountId.includes("..")
  ) {
    throw new Error("WeChat account id contains unsafe filename characters.");
  }
}

function requiredInputString(inputs: MessagingHookInputMap | undefined, key: string): string {
  const value = optionalInputString(inputs, key);
  if (!value) {
    throw new Error(`WeChat account seeding requires ${key}.`);
  }
  return value;
}

function optionalInputString(inputs: MessagingHookInputMap | undefined, key: string): string {
  const value = inputs?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function isoTimestamp(now: WechatSeedOpenClawAccountHookOptions["now"]): string {
  const value = now?.() ?? new Date();
  return typeof value === "string" ? value : value.toISOString();
}
